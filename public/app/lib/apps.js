// The six apps of the grid, as the product names them, with the look of each card.

export const APPS = {
  affify: { name: "Affify", icon: "megaphone", color: "#3d8fff", tagline: "Landing pages and lead-gen funnels" },
  journey: { name: "Journey Builder", icon: "workflow", color: "#8b6bff", tagline: "Multi-step quizzes and visitor journeys" },
  reach: { name: "Reach", icon: "send", color: "#1fcb89", tagline: "Follow up with leads across channels" },
  insights: { name: "Insights", icon: "chart-column", color: "#f2b33e", tagline: "Reports, attribution and dashboards" },
  vault: { name: "Vault", icon: "shield-check", color: "#3a8a52", tagline: "Lead records and compliance proof" },
  connect: { name: "Connect", icon: "plug", color: "#ff7a59", tagline: "Integrations and data sync" },
};

export const APP_KEYS = Object.keys(APPS);

export function appInfo(key) {
  return APPS[key] ?? { name: key, icon: "box", color: "#748296", tagline: "" };
}

/** What a card says about an app's state. */
export function appStateLabel(app) {
  switch (app.state) {
    case "ACTIVE":
      return { text: "Available", kind: "success" };
    case "COMING_SOON":
      return { text: "Coming soon", kind: "info" };
    case "UPGRADE":
      return { text: `Needs ${app.requiredPlan ?? "a higher"} plan`, kind: "warning" };
    case "RESTRICTED":
      return { text: `${(app.requiredRole ?? "Owner").toLowerCase().replace(/^./, (c) => c.toUpperCase())} only`, kind: "" };
    default:
      return { text: app.state ?? "", kind: "" };
  }
}
