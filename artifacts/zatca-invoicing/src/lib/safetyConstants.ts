// Occupational Safety & Health (OSH) UI enums.
// API access is contract-first via the generated client (@workspace/api-client-react);
// this module holds only the option lists the dropdowns render.

export const HAZARD_CATEGORIES = [
  "mechanical", "electrical", "chemical", "ergonomic", "biological",
  "physical", "psychosocial", "fire", "fall", "environmental", "other",
] as const;
export const RISK_LEVELS = ["low", "medium", "high", "critical"] as const;
export const RISK_STATUSES = ["open", "in_review", "controlled", "closed"] as const;
export const CONTROL_TYPES = ["elimination", "substitution", "engineering", "administrative", "ppe"] as const;
export const CONTROL_STATUSES = ["planned", "in_progress", "done"] as const;
export const INCIDENT_TYPES = [
  "near_miss", "unsafe_condition", "property_damage", "injury", "occupational_illness", "environmental",
] as const;
export const SEVERITY_CLASSES = ["no_treatment", "first_aid", "medical_treatment", "lost_time", "fatality"] as const;
export const INCIDENT_STATUSES = ["open", "investigating", "action_pending", "closed"] as const;
export const ACTION_TYPES = ["corrective", "preventive"] as const;
export const ACTION_STATUSES = ["open", "in_progress", "done"] as const;

export type RiskLevel = (typeof RISK_LEVELS)[number];
