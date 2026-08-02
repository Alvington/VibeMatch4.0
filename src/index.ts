import "dotenv/config";
import express, { Request, Response, NextFunction } from "express";
import cors from "cors";
import http from "http";
import { Server } from "socket.io";
import { prisma } from "./db";
import { sendSms, hasRealCredentials } from "./sms";
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
// Auth: request + verify a one-time code over SMS
// ---------------------------------------------------------------------------

app.post("/api/auth/request-otp", async (req: Request, res: Response) => {
  const { phoneNumber } = req.body as { phoneNumber?: string };
  if (!phoneNumber) return res.status(400).json({ error: "phoneNumber is required" });

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

  await sendSms(phoneNumber, `Your VibeMatch verification code is ${otp}. It expires in 5 minutes.`);

  // Dev convenience: with no real Africa's Talking credentials configured, the code
  // isn't going anywhere real - hand it back in the response so you can test without
  // tailing server logs. Remove this once AT_API_KEY is set to a real sandbox key.
  res.json({ sent: true, devOtp: hasRealCredentials ? undefined : otp });
});

app.post("/api/auth/verify-otp", async (req: Request, res: Response) => {
  const { phoneNumber, otp } = req.body as { phoneNumber?: string; otp?: string };
  if (!phoneNumber || !otp) return res.status(400).json({ error: "phoneNumber and otp are required" });

  const record = await prisma.otpCode.findUnique({ where: { phoneNumber } });
  if (!record || record.otp !== otp || Date.now() > record.expiresAt.getTime()) {
    return res.status(401).json({ error: "Invalid or expired code" });
  }
  await prisma.otpCode.delete({ where: { phoneNumber } });

  const user = await prisma.user.upsert({
    where: { phoneNumber },
    update: {},
    create: { phoneNumber },
  });

  res.json({ userId: user.id, profileDone: user.profileDone });
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