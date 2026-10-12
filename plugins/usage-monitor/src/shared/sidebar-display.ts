/** What the sidebar card shows (settings `usage.sidebar.*`). */
export interface SidebarDisplay {
  showToday: boolean;
  showBurnRate: boolean;
  showLimits: boolean;
  showSessions: boolean;
  maxSessions: number;
  showProject: boolean;
}

export const DEFAULT_SIDEBAR_DISPLAY: SidebarDisplay = {
  showToday: true,
  showBurnRate: true,
  showLimits: true,
  showSessions: true,
  maxSessions: 4,
  showProject: true,
};
