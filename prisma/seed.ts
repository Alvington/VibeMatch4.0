import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

// Roughly spread around Nairobi so distance filtering has something to do.
const users = [
  {
    phoneNumber: "+254700000001", name: "Amaka", age: 24, gender: "female",
    bio: "Hiking on weekends, jazz on weeknights.",
    latitude: -1.2921, longitude: 36.8219, // Nairobi CBD
    vibeAnswers: [4, 2, 5, 3], seekingGender: "male", minAge: 22, maxAge: 30,
    interests: ["hiking", "jazz", "coffee"],
  },
  {
    phoneNumber: "+254700000002", name: "Brian", age: 27, gender: "male",
    bio: "Runs a small dev shop, terrible at cooking.",
    latitude: -1.3031, longitude: 36.7073, // Karen
    vibeAnswers: [4, 3, 5, 2], seekingGender: "female", minAge: 21, maxAge: 29,
    interests: ["coding", "hiking", "coffee"],
  },
  {
    phoneNumber: "+254700000003", name: "Cynthia", age: 22, gender: "female",
    bio: "Museum-hopper, always cold.",
    latitude: -1.2833, longitude: 36.8167, // Westlands
    vibeAnswers: [2, 5, 2, 4], seekingGender: "male", minAge: 22, maxAge: 32,
    interests: ["art", "reading", "tea"],
  },
  {
    phoneNumber: "+254700000004", name: "Derrick", age: 29, gender: "male",
    bio: "Weekend footballer, weekday spreadsheet person.",
    latitude: -1.3197, longitude: 36.8830, // South B
    vibeAnswers: [5, 1, 4, 5], seekingGender: "female", minAge: 23, maxAge: 30,
    interests: ["football", "coding"],
  },
  {
    phoneNumber: "+254700000005", name: "Faith", age: 26, gender: "female",
    bio: "Trail runner and amateur baker.",
    latitude: -1.2667, longitude: 36.8000, // Parklands
    vibeAnswers: [4, 2, 5, 3], seekingGender: "male", minAge: 24, maxAge: 33,
    interests: ["hiking", "baking", "coffee"],
  },
  {
    phoneNumber: "+254700000006", name: "George", age: 25, gender: "male",
    bio: "Jazz records and long commutes.",
    latitude: -1.3000, longitude: 36.8300, // near CBD
    vibeAnswers: [3, 2, 5, 3], seekingGender: "female", minAge: 21, maxAge: 28,
    interests: ["jazz", "reading"],
  },
];

async function main() {
  for (const u of users) {
    const { interests, vibeAnswers, ...rest } = u;
    await prisma.user.upsert({
      where: { phoneNumber: u.phoneNumber },
      update: {},
      create: {
        ...rest,
        vibeAnswers: JSON.stringify(vibeAnswers),
        maxDistanceKm: 50,
        profileDone: true,
        interests: {
          connectOrCreate: interests.map((name) => ({ where: { name }, create: { name } })),
        },
      },
    });
  }
  console.log(`Seeded ${users.length} users.`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
