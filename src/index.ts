import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import { prisma } from "./db";
import { sendSms, hasRealCredentials } from "./sms";
import { sendEmail, hasEmailCredentials } from "./email";
import bcrypt from "bcryptjs";
import { haversineKm, vibeScore, interestOverlap, combinedVibeScore, overallScore } from "./matching";

const app = express();
app.use(cors());
app.use(express.json({ limit: "6mb" }));
app.use(express.static("public"));

const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" }, maxHttpBufferSize: 8e6 });

// Health check for Render (and anyone else) to confirm the process is up.
app.get("/healthz", (_req: Request, res: Response) => {
  res.status(200).json({ status: "ok" });
});

// ---------------------------------------------------------------------------
// Auth
//
// First-time verification (by SMS or email OTP) plus a password afterward -
// not OTP on every single login. One endpoint,
// /api/auth/verify-otp-set-password, handles three cases that are all really
// the same underlying action ("prove you control this phone, then set a
// password"): signing up, a legacy no-password account setting one for the
// first time, and a forgot-password reset.
// ---------------------------------------------------------------------------

// Tells the frontend which screen to show for a given number - password entry,
// or the OTP-plus-password-setup flow (covers both brand-new numbers and
// legacy accounts created before passwords existed).
app.post("/api/auth/lookup", async (req: Request, res: Response) => {
  const { phoneNumber } = req.body as { phoneNumber?: string };
  if (!phoneNumber) return res.status(400).json({ error: "phoneNumber is required" });
  const user = await prisma.user.findUnique({ where: { phoneNumber } });
  res.json({ exists: !!user, hasPassword: !!user?.passwordHash, hasEmail: !!user?.email });
});

app.post("/api/auth/login", async (req: Request, res: Response) => {
  try {
    const { phoneNumber, password } = req.body as { phoneNumber?: string; password?: string };
    if (!phoneNumber || !password) return res.status(400).json({ error: "Phone number and password are required" });

    const user = await prisma.user.findUnique({ where: { phoneNumber } });
    if (!user) return res.status(404).json({ error: "No account with that number yet." });
    if (!user.passwordHash) {
      return res.status(409).json({
        error: "no_password_set",
        message: "This account doesn't have a password yet - verify your number to set one.",
        hasEmail: !!user.email,
      });
    }
    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) return res.status(401).json({ error: "Incorrect password." });

    res.json({ userId: user.id, profileDone: user.profileDone });
  } catch (err: any) {
    console.error("login failed:", err);
    res.status(500).json({ error: "Login failed", detail: err?.message });
  }
});

app.post("/api/auth/request-otp", async (req: Request, res: Response) => {
  try {
    const { phoneNumber, channel, email } = req.body as { phoneNumber?: string; channel?: "sms" | "email"; email?: string };
    if (!phoneNumber) return res.status(400).json({ error: "phoneNumber is required" });

    const existingUser = await prisma.user.findUnique({ where: { phoneNumber } });

    // Where an email code actually goes depends on whether this number already
    // has an account. For an existing account we only ever use the email
    // already on file - trusting a client-supplied address here would let
    // anyone "reset" someone else's account to an email they control.
    // For a brand-new signup there's no account yet to hijack, so the address
    // they just typed is what they're claiming as theirs.
    let targetEmail: string | null = null;
    if (channel === "email") {
      targetEmail = existingUser ? existingUser.email : (email?.trim() || null);
      if (!targetEmail) {
        return res.status(400).json({
          error: existingUser ? "No email on file for this account - use SMS instead." : "Enter an email to receive the code there.",
        });
      }
    }

    const otp = String(Math.floor(100000 + Math.random() * 900000)); // 6 digits
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000);

    // Stored in Postgres (not process memory) so the code survives a server
    // restart between "request" and "verify" - important on hosts like Render
    // where the instance can restart or spin down between the two requests.
    await prisma.otpCode.upsert({
      where: { phoneNumber },
      update: { otp, expiresAt },
      create: { phoneNumber, otp, expiresAt },
    });

    const usingEmail = channel === "email" && targetEmail;
    if (usingEmail) {
      await sendEmail(targetEmail!, "Your VibeMatch verification code", `Your VibeMatch verification code is ${otp}. It expires in 5 minutes.`);
    } else {
      await sendSms(phoneNumber, `Your VibeMatch verification code is ${otp}. It expires in 5 minutes.`);
    }

    // Dev convenience: with no real credentials configured for whichever channel
    // was actually used, the code isn't going anywhere real - hand it back in
    // the response so you can test without tailing server logs.
    const devMode = usingEmail ? !hasEmailCredentials : !hasRealCredentials;
    res.json({ sent: true, channel: usingEmail ? "email" : "sms", devOtp: devMode ? otp : undefined });
  } catch (err: any) {
    console.error("request-otp failed:", err);
    res.status(500).json({ error: "Failed to send code", detail: err?.message });
  }
});

app.post("/api/auth/verify-otp-set-password", async (req: Request, res: Response) => {
  try {
    const { phoneNumber, otp, password, email } = req.body as {
      phoneNumber?: string; otp?: string; password?: string; email?: string;
    };
    if (!phoneNumber || !otp || !password) return res.status(400).json({ error: "Phone number, code, and password are required" });
    if (password.length < 6) return res.status(400).json({ error: "Password must be at least 6 characters." });

    const record = await prisma.otpCode.findUnique({ where: { phoneNumber } });
    if (!record || record.otp !== otp || Date.now() > record.expiresAt.getTime()) {
      return res.status(401).json({ error: "Invalid or expired code" });
    }
    await prisma.otpCode.delete({ where: { phoneNumber } });

    const passwordHash = await bcrypt.hash(password, 10);
    const existingUser = await prisma.user.findUnique({ where: { phoneNumber } });

    // Existing account (legacy no-password user, or a forgot-password reset):
    // only ever touch the password here, never the email - changing the email
    // is a separate, deliberate action, not a side effect of a reset.
    // Brand-new signup: create the user, optionally with the email they typed.
    const user = existingUser
      ? await prisma.user.update({ where: { phoneNumber }, data: { passwordHash } })
      : await prisma.user.create({ data: { phoneNumber, passwordHash, email: email?.trim() || null } });

    res.json({ userId: user.id, profileDone: user.profileDone });
  } catch (err: any) {
    if (err.code === "P2002") return res.status(409).json({ error: "That email is already in use by another account." });
    console.error("verify-otp-set-password failed:", err);
    res.status(500).json({ error: "Failed to verify code", detail: err?.message });
  }
});

// ---------------------------------------------------------------------------
// Profile
// ---------------------------------------------------------------------------

// Powers pre-filling the profile form with the user's saved data - without
// this, every visit to the profile page looked blank/default even after saving.
app.get("/api/profile/:userId", async (req: Request, res: Response) => {
  try {
    const userId = Number(req.params.userId);
    const user = await prisma.user.findUnique({ where: { id: userId }, include: { interests: true } });
    if (!user) return res.status(404).json({ error: "User not found" });

    res.json({
      ...user,
      vibeAnswers: JSON.parse(user.vibeAnswers) as number[],
      interests: user.interests.map((i: (typeof user.interests)[number]) => i.name),
    });
  } catch (err: any) {
    console.error("GET /api/profile failed:", err);
    res.status(500).json({ error: "Failed to load profile", detail: err?.message });
  }
});

app.put("/api/profile/:userId", async (req: Request, res: Response) => {
  try {
    const userId = Number(req.params.userId);
    const {
      name, age, gender, bio, photoUrl, latitude, longitude,
      vibeAnswers, seekingGender, minAge, maxAge, maxDistanceKm, interests,
    } = req.body as {
      name?: string; age?: number; gender?: string; bio?: string; photoUrl?: string;
      latitude?: number; longitude?: number; vibeAnswers?: number[];
      seekingGender?: string; minAge?: number; maxAge?: number;
      maxDistanceKm?: number; interests?: string[];
    };

    const interestConnections = (interests ?? []).map((name) => ({
      where: { name },
      create: { name },
    }));

    const user = await prisma.user.update({
      where: { id: userId },
      data: {
        name, age, gender, bio, photoUrl, latitude, longitude,
        seekingGender, minAge, maxAge, maxDistanceKm,
        vibeAnswers: vibeAnswers ? JSON.stringify(vibeAnswers) : undefined,
        profileDone: true,
        // Interests are fully replaced on every save (not just added to) so
        // removing a chip on the frontend actually removes it here too.
        interests: { set: [], connectOrCreate: interestConnections },
      },
      include: { interests: true },
    });

    res.json(user);
  } catch (err: any) {
    // Logged in full server-side (Render logs); client gets a safe summary so
    // we're not leaking internals, but enough to tell what kind of failure it was.
    console.error("PUT /api/profile failed:", err);
    res.status(500).json({ error: "Failed to save profile", detail: err?.message });
  }
});

// ---------------------------------------------------------------------------
// Discovery - hard filters (gender/age/distance) then soft ranking (vibe + interests)
// ---------------------------------------------------------------------------

app.get("/api/discover/:userId", async (req: Request, res: Response) => {
  const userId = Number(req.params.userId);
  const me = await prisma.user.findUnique({ where: { id: userId }, include: { interests: true } });
  if (!me) return res.status(404).json({ error: "User not found" });

  // Exclude anyone already liked, plus the current user
  const alreadyLiked = await prisma.like.findMany({ where: { fromUserId: userId } });
  const excludeIds = [userId, ...alreadyLiked.map((l: (typeof alreadyLiked)[number]) => l.toUserId)];

  const candidates = await prisma.user.findMany({
    where: {
      id: { notIn: excludeIds },
      profileDone: true,
      ...(me.seekingGender !== "any" ? { gender: me.seekingGender } : {}),
      age: { gte: me.minAge, lte: me.maxAge },
    },
    include: { interests: true },
  });

  const meVibe = JSON.parse(me.vibeAnswers) as number[];
  const meInterestIds = me.interests.map((i: (typeof me.interests)[number]) => i.id);

  interface RankedCandidate {
    id: number; name: string; age: number; bio: string | null; photoUrl: string | null;
    interests: string[]; distanceKm: number; vibePercent: number;
    sharedInterestCount: number; score: number;
  }

  const ranked = candidates
    .map((c: (typeof candidates)[number]) => {
      const distanceKm = haversineKm(me.latitude, me.longitude, c.latitude, c.longitude);
      const cInterestIds = c.interests.map((i: (typeof c.interests)[number]) => i.id);
      const shared = cInterestIds.filter((id: number) => meInterestIds.includes(id)).length;
      const quizVibe = vibeScore(meVibe, JSON.parse(c.vibeAnswers) as number[]);
      const overlap = interestOverlap(meInterestIds, cInterestIds);
      const combined = combinedVibeScore(quizVibe, overlap);
      return {
        id: c.id, name: c.name, age: c.age, bio: c.bio, photoUrl: c.photoUrl,
        interests: c.interests.map((i: (typeof c.interests)[number]) => i.name),
        distanceKm: Math.round(distanceKm * 10) / 10,
        vibePercent: Math.round(combined * 100),
        sharedInterestCount: shared,
        score: overallScore(combined, shared),
      };
    })
    .filter((c: RankedCandidate) => c.distanceKm <= me.maxDistanceKm)
    .sort((a: RankedCandidate, b: RankedCandidate) => b.score - a.score);

  res.json(ranked);
});

// ---------------------------------------------------------------------------
// Liking + mutual match detection
// ---------------------------------------------------------------------------

app.post("/api/like", async (req: Request, res: Response) => {
  const { fromUserId, toUserId } = req.body as { fromUserId: number; toUserId: number };
  if (!fromUserId || !toUserId) return res.status(400).json({ error: "fromUserId and toUserId are required" });

  await prisma.like.upsert({
    where: { fromUserId_toUserId: { fromUserId, toUserId } },
    update: {},
    create: { fromUserId, toUserId },
  });

  const mutual = await prisma.like.findUnique({
    where: { fromUserId_toUserId: { fromUserId: toUserId, toUserId: fromUserId } },
  });

  if (!mutual) return res.json({ matched: false });

  // Store the match with a stable ordering so the unique constraint can't be bypassed
  const [userAId, userBId] = [fromUserId, toUserId].sort((a, b) => a - b);
  const match = await prisma.match.upsert({
    where: { userAId_userBId: { userAId, userBId } },
    update: {},
    create: { userAId, userBId },
  });

  const [userA, userB] = await Promise.all([
    prisma.user.findUnique({ where: { id: userAId } }),
    prisma.user.findUnique({ where: { id: userBId } }),
  ]);

  if (userA && userB) {
    await sendSms(userA.phoneNumber, `🎉 It's a match with ${userB.name} on VibeMatch!`);
    await sendSms(userB.phoneNumber, `🎉 It's a match with ${userA.name} on VibeMatch!`);
  }

  res.json({ matched: true, matchId: match.id });
});

// ---------------------------------------------------------------------------
// Matches + message history
// ---------------------------------------------------------------------------

app.get("/api/matches/:userId", async (req: Request, res: Response) => {
  const userId = Number(req.params.userId);
  const matches = await prisma.match.findMany({
    where: { OR: [{ userAId: userId }, { userBId: userId }] },
    orderBy: { createdAt: "desc" },
  });

  const withCounterpart = await Promise.all(
    matches.map(async (m: (typeof matches)[number]) => {
      const otherId = m.userAId === userId ? m.userBId : m.userAId;
      const other = await prisma.user.findUnique({ where: { id: otherId } });
      return { matchId: m.id, createdAt: m.createdAt, otherUser: { id: other?.id, name: other?.name, photoUrl: other?.photoUrl } };
    })
  );

  res.json(withCounterpart);
});

app.get("/api/messages/:matchId", async (req: Request, res: Response) => {
  const matchId = Number(req.params.matchId);
  const messages = await prisma.message.findMany({
    where: { matchId },
    orderBy: { createdAt: "asc" },
  });
  res.json(messages);
});

// ---------------------------------------------------------------------------
// Real-time chat - a socket room per match, so only the two matched users
// who both know the matchId can ever join it or receive its messages.
// ---------------------------------------------------------------------------

io.on("connection", (socket) => {
  socket.on("join_match", (matchId: number) => {
    socket.join(`match_${matchId}`);
  });

  socket.on(
    "send_message",
    async ({ matchId, senderId, content, audioUrl, audioDurationSec }: {
      matchId: number; senderId: number; content?: string; audioUrl?: string; audioDurationSec?: number;
    }) => {
      if (!content?.trim() && !audioUrl) return; // nothing to send
      try {
        const message = await prisma.message.create({
          data: { matchId, senderId, content: content?.trim() || null, audioUrl: audioUrl || null, audioDurationSec: audioDurationSec || null },
        });
        io.to(`match_${matchId}`).emit("new_message", message);
      } catch (err: any) {
        console.error("send_message failed:", err);
        // Told back to the sender only, not the whole room - so a failure doesn't
        // silently vanish the way the old SMS error-handling used to.
        socket.emit("message_error", { matchId, error: "Failed to send message", detail: err?.message });
      }
    }
  );
});

// Catches anything routes don't handle themselves - notably express.json()
// throwing synchronously if a request body is over the 6mb limit, which
// otherwise renders as an opaque HTML error page instead of JSON.
app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
  console.error("Unhandled error:", err);
  if (err?.type === "entity.too.large") {
    return res.status(413).json({ error: "That photo is too large even after compression. Try a smaller image." });
  }
  res.status(500).json({ error: "Something went wrong on our end.", detail: err?.message });
});

const PORT = Number(process.env.PORT) || 3000;
server.listen(PORT, () => console.log(`VibeMatch backend running on http://localhost:${PORT}`));

// Render sends SIGTERM before stopping/redeploying an instance - close the HTTP
// server and DB connection cleanly instead of dropping connections mid-request.
async function shutdown() {
  console.log("Shutting down gracefully...");
  server.close(() => console.log("HTTP server closed"));
  await prisma.$disconnect();
  process.exit(0);
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);