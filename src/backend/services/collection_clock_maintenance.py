"""Administrative preflight/digest operations. Never called by public routes."""
from __future__ import annotations

import hashlib
import json
from uuid import uuid4

from psycopg import sql

from ..core.collection_clock_schema import CLOCK_COLLECTIONS, MAINTENANCE_ROLE, table_dependencies
from ..core.db_schema import DB_CHILD_PARENT_KEYS, DB_CHILD_TABLES, JSON_COLLECTION_TABLES


def maintenance_allowed(conn):
    return bool(conn.execute("SELECT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=%s "
                             "AND pg_has_role(session_user,oid,'MEMBER'))", (MAINTENANCE_ROLE,)).fetchone()[0])


def installed(conn):
    row = conn.execute("SELECT to_regclass('public.portal_data_generation'), "
                       "to_regclass('public.portal_collection_versions')").fetchone()
    if bool(row[0]) != bool(row[1]):
        raise RuntimeError("Incomplete collection-clock installation")
    return bool(row[0])


def primary_columns(conn, table):
    columns = [row[0] for row in conn.execute(
        "SELECT a.attname FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid "
        "JOIN pg_namespace n ON n.oid=c.relnamespace "
        "CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY AS k(attnum,position) "
        "JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum=k.attnum "
        "WHERE n.nspname='public' AND c.relname=%s AND i.indisprimary ORDER BY k.position", (table,))]
    if not columns:
        raise RuntimeError("Primary key required for canonical digest")
    return columns


def verify_schema(conn, *, require_application_role=False):
    tables = table_dependencies()
    if not installed(conn):
        raise RuntimeError("Collection clocks are not installed")
    columns = set(conn.execute("SELECT table_name FROM information_schema.columns "
                               "WHERE table_schema='public' AND column_name='organization_id' AND is_nullable='NO'").fetchall())
    if any((table,) not in columns for table in {*tables, "auth_devices"}):
        raise RuntimeError("Missing organization column in read dependencies")
    for table, collection in tables.items():
        primary_columns(conn, table)
        rows = conn.execute("SELECT t.tgname,t.tgenabled,pg_get_triggerdef(t.oid) "
                            "FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid "
                            "JOIN pg_namespace n ON n.oid=c.relnamespace "
                            "WHERE n.nspname='public' AND c.relname=%s AND NOT t.tgisinternal", (table,)).fetchall()
        triggers = {r[0]: r[1:] for r in rows}
        for event in ("insert", "update", "delete", "truncate"):
            entry = triggers.get("portal_clock_" + event)
            function = "portal_clock_truncate" if event == "truncate" else "portal_clock_bump"
            if not entry or entry[0] not in {"O", "A"} or function not in entry[1]:
                raise RuntimeError("Missing or disabled collection-clock trigger")
            if event != "truncate" and (f"'{collection}'" not in entry[1] or "FOR EACH STATEMENT" not in entry[1]):
                raise RuntimeError("Unexpected collection-clock trigger dependency")
        invalid = conn.execute(sql.SQL("SELECT EXISTS(SELECT 1 FROM public.{} WHERE organization_id IS NULL "
                                       "OR btrim(organization_id)='')").format(sql.Identifier(table))).fetchone()[0]
        if invalid:
            raise RuntimeError("Invalid organization identity")
    for parent, children in DB_CHILD_TABLES.items():
        if parent not in CLOCK_COLLECTIONS:
            continue
        for child in children:
            key = DB_CHILD_PARENT_KEYS[child]
            constraint = conn.execute(
                "SELECT EXISTS(SELECT 1 FROM pg_constraint k JOIN pg_class c ON c.oid=k.conrelid "
                "JOIN pg_class p ON p.oid=k.confrelid JOIN pg_namespace n ON n.oid=c.relnamespace "
                "WHERE n.nspname='public' AND p.relnamespace=n.oid AND c.relname=%s AND p.relname=%s "
                "AND k.contype='f' AND k.convalidated "
                "AND array_position(k.conkey,(SELECT attnum FROM pg_attribute WHERE attrelid=c.oid AND attname=%s)) "
                "=array_position(k.confkey,(SELECT attnum FROM pg_attribute WHERE attrelid=p.oid AND attname='id')))",
                (child, JSON_COLLECTION_TABLES[parent], key)).fetchone()[0]
            if not constraint:
                raise RuntimeError("Validated child foreign key required")
            invalid = conn.execute(sql.SQL("SELECT EXISTS(SELECT 1 FROM public.{} c LEFT JOIN public.{} p "
                                           "ON p.id=c.{} WHERE p.id IS NULL OR "
                                           "p.organization_id IS DISTINCT FROM c.organization_id)").format(
                                               sql.Identifier(child), sql.Identifier(JSON_COLLECTION_TABLES[parent]),
                                               sql.Identifier(key))).fetchone()[0]
            if invalid:
                raise RuntimeError("Child organization mismatch")
    if require_application_role:
        unsafe = conn.execute("SELECT rolsuper OR rolcreaterole OR rolreplication OR rolbypassrls "
                              "FROM pg_roles WHERE rolname=current_user").fetchone()[0]
        owners = conn.execute("SELECT EXISTS(SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace "
                              "WHERE n.nspname='public' AND c.relname=ANY(%s) "
                              "AND pg_has_role(current_user,c.relowner,'MEMBER'))",
                              (list(tables) + ["portal_data_generation", "portal_collection_versions"],)).fetchone()[0]
        schema_owner = conn.execute("SELECT has_schema_privilege(current_user,'public','CREATE') OR "
                                    "pg_has_role(current_user,(SELECT datdba FROM pg_database "
                                    "WHERE datname=current_database()),'MEMBER')").fetchone()[0]
        if unsafe or owners or schema_owner or maintenance_allowed(conn):
            raise RuntimeError("Clock reads require a non-owner application role without maintenance privileges")
        for table in tables:
            if conn.execute("SELECT has_table_privilege(current_user,%s,'TRUNCATE,TRIGGER')",
                            ("public."+table,)).fetchone()[0]:
                raise RuntimeError("Application business-table privileges are unsafe")
        for table in ("portal_data_generation", "portal_collection_versions"):
            privileges = conn.execute("SELECT has_table_privilege(current_user,%s,'SELECT'), "
                                      "has_table_privilege(current_user,%s,'INSERT,UPDATE,DELETE,TRUNCATE')",
                                      ("public."+table, "public."+table)).fetchone()
            if not privileges[0] or privileges[1]:
                raise RuntimeError("Application clock privileges are unsafe")


def canonical_digests(conn):
    """Caller owns one RR/READ ONLY transaction. Hash content, never xmin."""
    conn.execute("SET LOCAL TimeZone='UTC'")
    verify_schema(conn)
    generation = str(conn.execute("SELECT generation FROM public.portal_data_generation WHERE singleton=1").fetchone()[0])
    versions = {(org, name): int(v) for org, name, v in conn.execute(
        "SELECT organization_id,collection_name,version FROM public.portal_collection_versions")}
    entries = {}
    tables = table_dependencies()
    organizations = {org for org, _ in versions} | {"default"}
    for table in tables:
        organizations.update(r[0] for r in conn.execute(sql.SQL("SELECT DISTINCT organization_id FROM public.{}").format(sql.Identifier(table))))
    primary_keys = {table: primary_columns(conn, table) for table in tables}
    for org, name in sorted((org, name) for org in organizations for name in CLOCK_COLLECTIONS):
        version = versions.get((org, name), 0)
        parts = []
        for table, collection in tables.items():
            if collection != name:
                continue
            # jsonb key order and ISO conversion are stable in the fixed UTC session.
            rows = [r[0] for r in conn.execute(sql.SQL("SELECT to_jsonb(t) FROM public.{} t "
                                                       "WHERE organization_id=%s ORDER BY {}").format(
                                                           sql.Identifier(table), sql.SQL(',').join(
                                                               map(sql.Identifier, primary_keys[table]))), (org,))]
            serialized = [json.dumps(row, sort_keys=True, ensure_ascii=False, default=str,
                                     separators=(",", ":")) for row in rows]
            parts.append([table, serialized])
        if version == 0 and any(rows for _, rows in parts):
            raise RuntimeError("Collection data exists without its version")
        digest = hashlib.sha256(json.dumps(parts, ensure_ascii=False, separators=(",", ":")).encode()).hexdigest()
        entries[json.dumps([org, name], ensure_ascii=False)] = {"version": version, "hash": digest}
    return {"generation": generation, "entries": entries}


def compare_digests(previous, current):
    if previous.get("generation") != current["generation"]:
        return
    if not previous.get("entries", {}).keys() <= current["entries"].keys():
        raise RuntimeError("Collection version/digest anomaly: version rows disappeared")
    for key, entry in current["entries"].items():
        old = previous.get("entries", {}).get(key)
        if old and (entry["version"] < old["version"] or
                    (entry["version"] == old["version"] and entry["hash"] != old["hash"])):
            raise RuntimeError("Collection version/digest anomaly; disable version ETags and investigate")


def initialize_tenant(conn, organization):
    if not maintenance_allowed(conn) or not organization.strip():
        raise RuntimeError("Trusted maintenance role and organization required")
    organization = organization.strip()
    for collection in CLOCK_COLLECTIONS:
        conn.execute("INSERT INTO public.portal_collection_versions(organization_id,collection_name,version) "
                     "VALUES (%s,%s,1) ON CONFLICT DO NOTHING", (organization, collection))


def finalize_generation(conn):
    """Only after DB and GCS success, while maintenance/writer drain remain on."""
    if not maintenance_allowed(conn):
        raise RuntimeError("Trusted maintenance role required for generation finalization")
    verify_schema(conn)
    orgs = {"default"}
    for table in table_dependencies():
        orgs.update(r[0] for r in conn.execute(sql.SQL("SELECT DISTINCT organization_id FROM public.{}").format(sql.Identifier(table))))
    for org in sorted(orgs):
        initialize_tenant(conn, org)
    conn.execute("UPDATE public.portal_collection_versions SET version=version+1,updated_at=clock_timestamp()")
    generation = str(uuid4())
    conn.execute("UPDATE public.portal_data_generation SET generation=%s,updated_at=clock_timestamp() WHERE singleton=1",
                 (generation,))
    canonical_digests(conn)  # final completeness/content inspection before COMMIT
    return generation
