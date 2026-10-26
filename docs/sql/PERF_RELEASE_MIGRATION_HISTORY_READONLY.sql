-- Source: ac5b4e337bcbab06de7008098b38baf41a810f90, scripts/migrate_db.py checksum semantics.
-- Execute the whole script separately in TEST, then production. No DDL/DML.
-- Output: version and checksum_matches only. true=applied and matching;
-- NULL=not applied; false=mismatch/unexpected version/non-read-only session.
-- Before TEST release: 001..022 must all be true; only 023 may be NULL.
-- Unexpected/missing additional versions, false values, or query errors: STOP.
-- After applying 023: all 001..023 must be true and no extra rows may exist.
BEGIN READ ONLY;
SET LOCAL statement_timeout = '5s';
SET LOCAL lock_timeout = '1s';
SET LOCAL idle_in_transaction_session_timeout = '60s';

WITH expected(version, checksum) AS (
  VALUES
    ('001', 'dfdb5073561c9daac1958d0ba000754eb1fdb758c540dacb487b9073f66eb21e'),
    ('002', '7bfe8a58a01b6388370b0b845b56f8442494ce0c33ccad8dbe872ada2dc3a691'),
    ('003', '6c11ef0e7501fbe3cfd6b0d35a5d1ca19508cf7e0b4241797b6a7912afef4833'),
    ('004', 'f2053476c03ad448d61c23758f37500779a0be10662134ea027acd6873ad85b3'),
    ('005', 'f896c3e682b9c715c796e1a1a37b688f72587984c80abf2d760def78ace02765'),
    ('006', '6f9c23cb9c5ccafd6deb2d577f4ef0b1c6474c732bc19d5ca8142da16cfc618a'),
    ('007', '19d7b5cfeb01cc91d9aaa7675824fd7f686eb9e8f0c5f22a322c3a5811e5f32b'),
    ('008', 'e88e069edd9f0c80f3a6dabd689418bc30563a865ac20586132f85f751bcabcd'),
    ('009', 'b00532a048834031a36f0d3826d0060b18e8fc7b304e84ccf5ef162862800999'),
    ('010', 'b0649e90ed13f4fc16a4625db0c60cbf55ea1f00e1de9d2e43d164ac0ce86351'),
    ('011', '0d1f47e2dfc4a82e34c12d4cc459b4145c0852f2468aecdefcfe7c6d1932d4f1'),
    ('012', 'b7f90ccc6298f3094e5e5fff0bbf91e1cbd52c372e2f35f489c1e68405e92d55'),
    ('013', '5c711bcfeeaf402307bbe589854bd7ab56b07575bc094b195aa0eb5fcb7aeab0'),
    ('014', '79cde5cd01a4d5f44245f77a19cb4bb81503c18088405330f6fc7d161441ad17'),
    ('015', '1f729298032310210c78122371a90e05159fe4d4ca0924eba5ba645028e1d632'),
    ('016', 'af72c9b832aeed1ccba750708e05c5dd2b3205f9864e9346f10240abeabe5dac'),
    ('017', '9da9d9ab361fa3cb8631e3a7e3716d21dacfa17e9135179ae6d7ef0ad9a62518'),
    ('018', 'a8d08b160adcd21c8a9e653fe1c346a693fd79f936d19fcf45468155e957d23f'),
    ('019', 'b4481c26f150fcd3549ee83be59ada98a0c64ebcd8806bacdff14dd4dbaadcfd'),
    ('020', 'b618b67918dcf0f180128befd87aaeecfb2aa347317f2658e3aca2a2699177d5'),
    ('021', '9dbaf041f65f7ee5826d0fc1e9e5f2bb5950b7d7d043dbf3a0d3a54010b2b4a7'),
    ('022', '5ba5248ffa36f4c6c60c74318933b894b70eb0ae1f356d66f8dad6da029ebeec'),
    ('023', '10d608d9ccf57aa58d21a4e5373246de9e0877c33e7ad06780c45ea9c2fec7ab')
)
SELECT COALESCE(e.version, a.version) AS version,
       CASE WHEN e.version IS NULL THEN false
            WHEN a.version IS NULL THEN NULL::boolean
            ELSE current_setting('transaction_read_only') = 'on'
                 AND COALESCE(a.checksum = e.checksum, false)
       END AS checksum_matches
FROM expected e
FULL OUTER JOIN public.schema_migrations a ON a.version = e.version
ORDER BY version;

ROLLBACK;
