-- AlterTable
ALTER TABLE "Message" ALTER COLUMN "content" DROP NOT NULL;
ALTER TABLE "Message" ADD COLUMN "audioUrl" TEXT;
ALTER TABLE "Message" ADD COLUMN "audioDurationSec" INTEGER;
