-- Keep 020 applicable unchanged in installations that already ran it.
-- A chunk checkpoint records read offset, CRC, ZIP entry offset, generation
-- and size. An empty object means the step ended between complete files.
ALTER TABLE sheet_zip_jobs
    ADD COLUMN IF NOT EXISTS progress JSONB NOT NULL DEFAULT '{}'::jsonb;
