-- Replace free-text categories with reusable category records while preserving existing assignments.
CREATE TABLE "Category" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalizedName" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Category_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "Category_normalizedName_key" ON "Category"("normalizedName");

ALTER TABLE "Form" ADD COLUMN IF NOT EXISTS "categoryId" TEXT;
ALTER TABLE "Landing" ADD COLUMN IF NOT EXISTS "categoryId" TEXT;

INSERT INTO "Category" ("id", "name", "normalizedName", "createdAt", "updatedAt")
SELECT md5(normalized_name), display_name, normalized_name, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM (
    SELECT DISTINCT ON (lower(btrim(category)))
        btrim(category) AS display_name,
        lower(btrim(category)) AS normalized_name
    FROM (
        SELECT "category" FROM "Form"
        UNION ALL
        SELECT "category" FROM "Landing"
    ) AS legacy_categories
    WHERE category IS NOT NULL AND btrim(category) <> ''
    ORDER BY lower(btrim(category)), btrim(category)
) AS categories
ON CONFLICT ("normalizedName") DO NOTHING;

UPDATE "Form" AS form
SET "categoryId" = category.id
FROM "Category" AS category
WHERE form."category" IS NOT NULL
  AND btrim(form."category") <> ''
  AND category."normalizedName" = lower(btrim(form."category"));

UPDATE "Landing" AS landing
SET "categoryId" = category.id
FROM "Category" AS category
WHERE landing."category" IS NOT NULL
  AND btrim(landing."category") <> ''
  AND category."normalizedName" = lower(btrim(landing."category"));

ALTER TABLE "Form" DROP COLUMN "category";
ALTER TABLE "Landing" DROP COLUMN "category";

CREATE INDEX "Form_categoryId_idx" ON "Form"("categoryId");
CREATE INDEX "Landing_categoryId_idx" ON "Landing"("categoryId");

ALTER TABLE "Form" ADD CONSTRAINT "Form_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "Landing" ADD CONSTRAINT "Landing_categoryId_fkey"
    FOREIGN KEY ("categoryId") REFERENCES "Category"("id") ON DELETE SET NULL ON UPDATE CASCADE;
