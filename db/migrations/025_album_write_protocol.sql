-- PERF-R15: protocol checks only. The 024 safety CHECK remains in place:
-- this migration does NOT authorize guard activation or physical GC.
-- Apply in one transaction, as the same separate DDL owner as 024.
SET LOCAL lock_timeout = '5s';
LOCK TABLE public.albums, public.album_photos IN SHARE ROW EXCLUSIVE MODE;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_constraint
        WHERE conrelid='public.album_asset_gc_control'::regclass
          AND conname='album_gc_foundation_guard_disabled' AND convalidated) THEN
        RAISE EXCEPTION 'Album foundation safety constraint required';
    END IF;
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_class
        WHERE oid IN ('public.album_asset_gc_control'::regclass,
            'public.album_storage_assets'::regclass,
            'public.album_asset_gc_candidates'::regclass,
            'public.album_asset_read_leases'::regclass)
          AND relowner <> current_user::regrole) THEN
        RAISE EXCEPTION 'Album protocol requires the foundation DDL owner';
    END IF;
END $$;

CREATE FUNCTION public.album_require_write_protocol() RETURNS trigger
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $$
DECLARE enabled boolean;
BEGIN
    -- A SHARE lock keeps an observed false from changing to true while this
    -- write is still in flight. Controlled activation also requires writer drain.
    SELECT guard_enabled INTO enabled FROM public.album_asset_gc_control
        WHERE singleton=1 FOR SHARE;
    IF enabled IS TRUE THEN
        IF TG_OP='TRUNCATE' THEN
            RAISE EXCEPTION 'Album TRUNCATE is not permitted' USING ERRCODE='42501';
        END IF;
        IF current_setting('app.album_delete_protocol',true) IS DISTINCT FROM 'v2' THEN
            RAISE EXCEPTION 'Album writes require v2 protocol' USING ERRCODE='42501';
        END IF;
    END IF;
    -- No sync/maintenance bypass yet: settings alone are never authority.
    -- Asset-state locks, bindings, candidate collection and lease functions
    -- must be implemented before a later migration may permit activation.
    IF TG_LEVEL='STATEMENT' THEN RETURN NULL; END IF;
    IF TG_OP='DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
END $$;
REVOKE ALL ON FUNCTION public.album_require_write_protocol() FROM PUBLIC;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_catalog.pg_proc p
        CROSS JOIN LATERAL pg_catalog.aclexplode(p.proacl) a
        WHERE p.oid='public.album_require_write_protocol()'::regprocedure
          AND a.grantee <> p.proowner) THEN
        RAISE EXCEPTION 'Album protocol requires owner-only function ACLs';
    END IF;
END $$;

CREATE TRIGGER album_write_protocol BEFORE INSERT OR UPDATE OR DELETE
    ON public.albums FOR EACH ROW EXECUTE FUNCTION public.album_require_write_protocol();
CREATE TRIGGER album_photo_write_protocol BEFORE INSERT OR UPDATE OR DELETE
    ON public.album_photos FOR EACH ROW EXECUTE FUNCTION public.album_require_write_protocol();
CREATE TRIGGER album_truncate_protocol BEFORE TRUNCATE
    ON public.albums FOR EACH STATEMENT EXECUTE FUNCTION public.album_require_write_protocol();
CREATE TRIGGER album_photo_truncate_protocol BEFORE TRUNCATE
    ON public.album_photos FOR EACH STATEMENT EXECUTE FUNCTION public.album_require_write_protocol();
