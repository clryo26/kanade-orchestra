-- Prevent duplicates for the same performance x flyer distribution destination in one organization.
CREATE UNIQUE INDEX IF NOT EXISTS uq_flyer_distribution_assignments_org_perf_dist
ON flyer_distribution_assignments(organization_id, performance_id, flyer_distribution_id)
WHERE performance_id IS NOT NULL AND flyer_distribution_id IS NOT NULL;
