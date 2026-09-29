import { apiGet } from "../auth/client";

export interface ProductAnalyticsCounts {
  spaceJoins: number;
  eventParticipations: number;
  worldRejections: number;
  apiServerErrors: number;
}

export interface ProductAnalyticsDay {
  date: string;
  counts: ProductAnalyticsCounts;
}

export interface ProductAnalyticsDashboard {
  generatedAt: number;
  retentionDays: number;
  totals: ProductAnalyticsCounts;
  days: ProductAnalyticsDay[];
}

export function getProductAnalytics() {
  return apiGet<ProductAnalyticsDashboard>("admin/analytics");
}
