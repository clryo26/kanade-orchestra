ALTER TABLE desired_pieces
    ADD COLUMN IF NOT EXISTS reference_audio_url TEXT DEFAULT '',
    ADD COLUMN IF NOT EXISTS reference_score_url TEXT DEFAULT '';
