-- PERF-R15: nullable private bindings only, not GC activation.
-- Apply as the 024 DDL owner, transactionally after backup and writer drain.
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.albums, public.album_photos IN SHARE ROW EXCLUSIVE MODE;
DO $$
DECLARE t text;
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
        WHERE conrelid='public.album_asset_gc_control'::regclass
          AND conname='album_gc_foundation_guard_disabled' AND convalidated) THEN
        RAISE EXCEPTION 'Album foundation safety constraint required';
    END IF;
    IF (SELECT relowner FROM pg_catalog.pg_class
        WHERE oid='public.album_storage_assets'::regclass) <> current_user::regrole THEN
        RAISE EXCEPTION 'Album references require the foundation DDL owner';
    END IF;
    FOREACH t IN ARRAY ARRAY['albums','album_photos'] LOOP
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
            AND table_name=t AND column_name='organization_id' AND is_nullable='NO') THEN
            RAISE EXCEPTION 'Non-null organization column required: %', t;
        END IF;
    END LOOP;
    FOREACH t IN ARRAY ARRAY['object_name','path','url','uploaded_at'] LOOP
        IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public'
            AND table_name='album_photos' AND column_name=t) THEN
            RAISE EXCEPTION 'Album photo identity column required: %', t;
        END IF;
    END LOOP;
END $$;

-- Composite UNIQUE constraints are needed for the typed FKs below, even though
-- asset_id is already a PK. Include their index cost in the eventual live sizing.
ALTER TABLE public.album_storage_assets
    ADD CONSTRAINT album_assets_id_kind_key UNIQUE (asset_id, kind),
    ADD CONSTRAINT album_assets_id_parent_kind_key UNIQUE (asset_id, parent_asset_id, kind);
ALTER TABLE public.album_photos
    ADD COLUMN original_asset_id uuid,
    ADD COLUMN thumbnail_asset_id uuid,
    -- Constant defaults avoid a generated-STORED-column rewrite of old photos.
    ADD COLUMN original_asset_kind text NOT NULL DEFAULT 'original' CHECK (original_asset_kind='original'),
    ADD COLUMN thumbnail_asset_kind text NOT NULL DEFAULT 'thumbnail' CHECK (thumbnail_asset_kind='thumbnail'),
    ADD CONSTRAINT album_photo_original_asset_fk FOREIGN KEY (original_asset_id, original_asset_kind)
        REFERENCES public.album_storage_assets(asset_id, kind),
    ADD CONSTRAINT album_photo_thumbnail_asset_fk FOREIGN KEY (thumbnail_asset_id, original_asset_id, thumbnail_asset_kind)
        REFERENCES public.album_storage_assets(asset_id, parent_asset_id, kind),
    ADD CONSTRAINT album_photo_thumbnail_needs_original CHECK (thumbnail_asset_id IS NULL OR original_asset_id IS NOT NULL);
CREATE INDEX album_photos_original_asset ON public.album_photos(original_asset_id) WHERE original_asset_id IS NOT NULL;
CREATE INDEX album_photos_thumbnail_asset ON public.album_photos(thumbnail_asset_id) WHERE thumbnail_asset_id IS NOT NULL;

CREATE FUNCTION public.album_detach_changed_photo_asset() RETURNS trigger
LANGUAGE plpgsql SECURITY INVOKER SET search_path=pg_catalog AS $$
BEGIN
    -- Public metadata UPDATEs omit private columns: preserve the DB's current
    -- bindings. A different storage key must never retain the old generation.
    IF NEW.object_name IS DISTINCT FROM OLD.object_name OR NEW.path IS DISTINCT FROM OLD.path THEN
        NEW.original_asset_id := NULL;
        NEW.thumbnail_asset_id := NULL;
    ELSIF NEW.url IS DISTINCT FROM OLD.url OR NEW.uploaded_at IS DISTINCT FROM OLD.uploaded_at
        OR NEW.organization_id IS DISTINCT FROM OLD.organization_id THEN
        -- These fields participate in the v1 derived-image identity.
        NEW.thumbnail_asset_id := NULL;
    END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.album_detach_changed_photo_asset() FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
        CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
        WHERE p.oid='public.album_detach_changed_photo_asset()'::regprocedure AND a.grantee<>p.proowner) THEN
        RAISE EXCEPTION 'Album references require owner-only function ACLs';
    END IF;
END $$;
CREATE TRIGGER album_photo_detach_asset BEFORE UPDATE ON public.album_photos
    FOR EACH ROW EXECUTE FUNCTION public.album_detach_changed_photo_asset();
