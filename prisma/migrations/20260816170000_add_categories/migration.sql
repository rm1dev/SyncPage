-- Add optional categories for organizing forms and landings.
ALTER TABLE "Form" ADD COLUMN IF NOT EXISTS "category" TEXT;
ALTER TABLE "Landing" ADD COLUMN IF NOT EXISTS "category" TEXT;
