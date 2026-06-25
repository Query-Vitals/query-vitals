# recommendations

`RecommendationService` regenerates suggestions from current history plus live
indexes, persists them, and exposes dismiss. The pure `RecommendationEngine`
holds the rules:

- **Missing / composite (MySQL) and missing / compound (MongoDB)** — derive an
  index candidate per offending query, ordered equality → range → sort.
- **Redundant (MySQL)** — flag an index that is a left-prefix of another, or an
  exact duplicate of another (one side of the pair, deterministically). Unique
  indexes are never flagged: they carry a constraint.
- **Unused (MongoDB)** — flag indexes `$indexStats` reports zero accesses for,
  scoped to collections that saw query activity in the observation window, with
  `_id_` and stats-less indexes excluded.

Suggestions carry an estimated-impact figure and are dismissible.
