/**
 * workbench_shell_css —— mock「DSL 协作工作台」壳的 CSS 原样快照
 *
 * 来源：DSL 协作工作台.zip → pages/DSL 协作工作台.html 的三段 <style>
 * （theme-vars / semantic-token-fallback / critical-layout），逐行保留。
 * render_workbench 复用此壳，数据全换真。
 */

export const WORKBENCH_SHELL_CSS = ` 
/* DSL Workbench — adapted from Minimalist design system */
:root {
  /* surfaces */
  --dslw-background: #fafafa;
  --dslw-foreground: #0a0a0a;
  --dslw-card: #ffffff;
  --dslw-card-foreground: #0a0a0a;
  --dslw-popover: #ffffff;
  --dslw-popover-foreground: #0a0a0a;
  --dslw-primary: #111827;
  --dslw-primary-foreground: #ffffff;
  --dslw-secondary: #f4f4f5;
  --dslw-secondary-foreground: #0a0a0a;
  --dslw-muted: #f5f5f5;
  --dslw-muted-foreground: #71717a;
  --dslw-accent: #f4f4f5;
  --dslw-accent-foreground: #0a0a0a;
  --dslw-destructive: #dc2626;
  --dslw-destructive-foreground: #ffffff;
  --dslw-border: #e4e4e7;
  --dslw-border-strong: #d4d4d8;
  --dslw-input: #e4e4e7;
  --dslw-ring: #111827;

  /* sidebar */
  --dslw-sidebar: #fafafa;
  --dslw-sidebar-foreground: #0a0a0a;
  --dslw-sidebar-primary: #111827;
  --dslw-sidebar-primary-foreground: #ffffff;
  --dslw-sidebar-accent: #f4f4f5;
  --dslw-sidebar-accent-foreground: #0a0a0a;
  --dslw-sidebar-border: #e4e4e7;

  /* state colors */
  --dslw-success: #16a34a;
  --dslw-success-subtle: #f0fdf4;
  --dslw-success-border: #bbf7d0;
  --dslw-success-text: #15803d;
  --dslw-warning: #d97706;
  --dslw-warning-subtle: #fffbeb;
  --dslw-warning-border: #fde68a;
  --dslw-warning-text: #b45309;
  --dslw-danger-subtle: #fef2f2;
  --dslw-danger-border: #fecaca;
  --dslw-danger-text: #b91c1c;
  --dslw-info: #2563eb;
  --dslw-info-subtle: #eff6ff;
  --dslw-info-border: #bfdbfe;
  --dslw-info-text: #1d4ed8;

  /* brand tint for active/selected */
  --dslw-brand-subtle: #f4f4f5;
  --dslw-brand-border: #d4d4d8;

  /* typography */
  --dslw-font-sans: 'Inter', 'Geist', ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  --dslw-font-mono: 'Geist Mono', 'SF Mono', ui-monospace, 'Cascadia Code', monospace;

  /* radius */
  --dslw-radius: 0.625rem;
  --dslw-radius-sm: 0.375rem;
  --dslw-radius-lg: 0.875rem;

  /* shadows */
  --dslw-shadow-xs: 0 1px 2px rgba(0,0,0,0.04);
  --dslw-shadow-sm: 0 1px 3px rgba(0,0,0,0.06), 0 1px 2px rgba(0,0,0,0.04);
  --dslw-shadow: 0 4px 6px -1px rgba(0,0,0,0.06), 0 2px 4px -2px rgba(0,0,0,0.04);
  --dslw-shadow-md: 0 10px 15px -3px rgba(0,0,0,0.07), 0 4px 6px -4px rgba(0,0,0,0.04);
  --dslw-shadow-lg: 0 20px 25px -5px rgba(0,0,0,0.08), 0 8px 10px -6px rgba(0,0,0,0.04);

  /* chart/visualization monochrome ramp */
  --dslw-chart-1: #e4e4e7;
  --dslw-chart-2: #a1a1aa;
  --dslw-chart-3: #52525b;
  --dslw-chart-4: #27272a;
  --dslw-chart-5: #0a0a0a;

  /* canvas sandbox colors */
  --dslw-canvas-bg: #f8f8f8;
  --dslw-canvas-grid: #ececee;
  --dslw-node-bg: #ffffff;
  --dslw-node-border: #d4d4d8;
  --dslw-node-selected: #111827;
  --dslw-connection: #a1a1aa;
  --dslw-connection-active: #111827;
}

      .bg-background { background-color: var(--dslw-background); }
      .text-background { color: var(--dslw-background); }
      .border-background { border-color: var(--dslw-background); }
      .ring-background { --tw-ring-color: var(--dslw-background); }
      .bg-foreground { background-color: var(--dslw-foreground); }
      .text-foreground { color: var(--dslw-foreground); }
      .border-foreground { border-color: var(--dslw-foreground); }
      .ring-foreground { --tw-ring-color: var(--dslw-foreground); }
      .bg-card { background-color: var(--dslw-card); }
      .text-card { color: var(--dslw-card); }
      .border-card { border-color: var(--dslw-card); }
      .ring-card { --tw-ring-color: var(--dslw-card); }
      .bg-card-foreground { background-color: var(--dslw-card-foreground); }
      .text-card-foreground { color: var(--dslw-card-foreground); }
      .border-card-foreground { border-color: var(--dslw-card-foreground); }
      .ring-card-foreground { --tw-ring-color: var(--dslw-card-foreground); }
      .bg-popover { background-color: var(--dslw-popover); }
      .text-popover { color: var(--dslw-popover); }
      .border-popover { border-color: var(--dslw-popover); }
      .ring-popover { --tw-ring-color: var(--dslw-popover); }
      .bg-popover-foreground { background-color: var(--dslw-popover-foreground); }
      .text-popover-foreground { color: var(--dslw-popover-foreground); }
      .border-popover-foreground { border-color: var(--dslw-popover-foreground); }
      .ring-popover-foreground { --tw-ring-color: var(--dslw-popover-foreground); }
      .bg-primary { background-color: var(--dslw-primary); }
      .text-primary { color: var(--dslw-primary); }
      .border-primary { border-color: var(--dslw-primary); }
      .ring-primary { --tw-ring-color: var(--dslw-primary); }
      .bg-primary-foreground { background-color: var(--dslw-primary-foreground); }
      .text-primary-foreground { color: var(--dslw-primary-foreground); }
      .border-primary-foreground { border-color: var(--dslw-primary-foreground); }
      .ring-primary-foreground { --tw-ring-color: var(--dslw-primary-foreground); }
      .bg-secondary { background-color: var(--dslw-secondary); }
      .text-secondary { color: var(--dslw-secondary); }
      .border-secondary { border-color: var(--dslw-secondary); }
      .ring-secondary { --tw-ring-color: var(--dslw-secondary); }
      .bg-secondary-foreground { background-color: var(--dslw-secondary-foreground); }
      .text-secondary-foreground { color: var(--dslw-secondary-foreground); }
      .border-secondary-foreground { border-color: var(--dslw-secondary-foreground); }
      .ring-secondary-foreground { --tw-ring-color: var(--dslw-secondary-foreground); }
      .bg-muted { background-color: var(--dslw-muted); }
      .text-muted { color: var(--dslw-muted); }
      .border-muted { border-color: var(--dslw-muted); }
      .ring-muted { --tw-ring-color: var(--dslw-muted); }
      .bg-muted-foreground { background-color: var(--dslw-muted-foreground); }
      .text-muted-foreground { color: var(--dslw-muted-foreground); }
      .border-muted-foreground { border-color: var(--dslw-muted-foreground); }
      .ring-muted-foreground { --tw-ring-color: var(--dslw-muted-foreground); }
      .bg-accent { background-color: var(--dslw-accent); }
      .text-accent { color: var(--dslw-accent); }
      .border-accent { border-color: var(--dslw-accent); }
      .ring-accent { --tw-ring-color: var(--dslw-accent); }
      .bg-accent-foreground { background-color: var(--dslw-accent-foreground); }
      .text-accent-foreground { color: var(--dslw-accent-foreground); }
      .border-accent-foreground { border-color: var(--dslw-accent-foreground); }
      .ring-accent-foreground { --tw-ring-color: var(--dslw-accent-foreground); }
      .bg-destructive { background-color: var(--dslw-destructive); }
      .text-destructive { color: var(--dslw-destructive); }
      .border-destructive { border-color: var(--dslw-destructive); }
      .ring-destructive { --tw-ring-color: var(--dslw-destructive); }
      .bg-destructive-foreground { background-color: var(--dslw-destructive-foreground); }
      .text-destructive-foreground { color: var(--dslw-destructive-foreground); }
      .border-destructive-foreground { border-color: var(--dslw-destructive-foreground); }
      .ring-destructive-foreground { --tw-ring-color: var(--dslw-destructive-foreground); }
      .bg-border { background-color: var(--dslw-border); }
      .text-border { color: var(--dslw-border); }
      .border-border { border-color: var(--dslw-border); }
      .ring-border { --tw-ring-color: var(--dslw-border); }
      .bg-input { background-color: var(--dslw-input); }
      .text-input { color: var(--dslw-input); }
      .border-input { border-color: var(--dslw-input); }
      .ring-input { --tw-ring-color: var(--dslw-input); }
      .bg-ring { background-color: var(--dslw-ring); }
      .text-ring { color: var(--dslw-ring); }
      .border-ring { border-color: var(--dslw-ring); }
      .ring-ring { --tw-ring-color: var(--dslw-ring); }
      .bg-chart-1 { background-color: var(--dslw-chart-1); }
      .text-chart-1 { color: var(--dslw-chart-1); }
      .border-chart-1 { border-color: var(--dslw-chart-1); }
      .ring-chart-1 { --tw-ring-color: var(--dslw-chart-1); }
      .bg-chart-2 { background-color: var(--dslw-chart-2); }
      .text-chart-2 { color: var(--dslw-chart-2); }
      .border-chart-2 { border-color: var(--dslw-chart-2); }
      .ring-chart-2 { --tw-ring-color: var(--dslw-chart-2); }
      .bg-chart-3 { background-color: var(--dslw-chart-3); }
      .text-chart-3 { color: var(--dslw-chart-3); }
      .border-chart-3 { border-color: var(--dslw-chart-3); }
      .ring-chart-3 { --tw-ring-color: var(--dslw-chart-3); }
      .bg-chart-4 { background-color: var(--dslw-chart-4); }
      .text-chart-4 { color: var(--dslw-chart-4); }
      .border-chart-4 { border-color: var(--dslw-chart-4); }
      .ring-chart-4 { --tw-ring-color: var(--dslw-chart-4); }
      .bg-chart-5 { background-color: var(--dslw-chart-5); }
      .text-chart-5 { color: var(--dslw-chart-5); }
      .border-chart-5 { border-color: var(--dslw-chart-5); }
      .ring-chart-5 { --tw-ring-color: var(--dslw-chart-5); }
      .bg-sidebar { background-color: var(--dslw-sidebar); }
      .text-sidebar { color: var(--dslw-sidebar); }
      .border-sidebar { border-color: var(--dslw-sidebar); }
      .ring-sidebar { --tw-ring-color: var(--dslw-sidebar); }
      .bg-sidebar-foreground { background-color: var(--dslw-sidebar-foreground); }
      .text-sidebar-foreground { color: var(--dslw-sidebar-foreground); }
      .border-sidebar-foreground { border-color: var(--dslw-sidebar-foreground); }
      .ring-sidebar-foreground { --tw-ring-color: var(--dslw-sidebar-foreground); }
      .bg-sidebar-primary { background-color: var(--dslw-sidebar-primary); }
      .text-sidebar-primary { color: var(--dslw-sidebar-primary); }
      .border-sidebar-primary { border-color: var(--dslw-sidebar-primary); }
      .ring-sidebar-primary { --tw-ring-color: var(--dslw-sidebar-primary); }
      .bg-sidebar-primary-foreground { background-color: var(--dslw-sidebar-primary-foreground); }
      .text-sidebar-primary-foreground { color: var(--dslw-sidebar-primary-foreground); }
      .border-sidebar-primary-foreground { border-color: var(--dslw-sidebar-primary-foreground); }
      .ring-sidebar-primary-foreground { --tw-ring-color: var(--dslw-sidebar-primary-foreground); }
      .bg-sidebar-accent { background-color: var(--dslw-sidebar-accent); }
      .text-sidebar-accent { color: var(--dslw-sidebar-accent); }
      .border-sidebar-accent { border-color: var(--dslw-sidebar-accent); }
      .ring-sidebar-accent { --tw-ring-color: var(--dslw-sidebar-accent); }
      .bg-sidebar-accent-foreground { background-color: var(--dslw-sidebar-accent-foreground); }
      .text-sidebar-accent-foreground { color: var(--dslw-sidebar-accent-foreground); }
      .border-sidebar-accent-foreground { border-color: var(--dslw-sidebar-accent-foreground); }
      .ring-sidebar-accent-foreground { --tw-ring-color: var(--dslw-sidebar-accent-foreground); }
      .no-scrollbar::-webkit-scrollbar { display: none; }
      .no-scrollbar { -ms-overflow-style: none; scrollbar-width: none; }
      [data-icon] {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        -webkit-mask-size: contain;
        mask-size: contain;
        -webkit-mask-repeat: no-repeat;
        mask-repeat: no-repeat;
        -webkit-mask-position: center;
        mask-position: center;
        background-color: currentColor;
      }
  /* ===== Critical App Shell Layout ===== */
  *, *::before, *::after { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; height: 100%; overflow: hidden; min-width: 1200px; }

  .dslw-app {
    display: grid;
    grid-template-columns: 240px 1fr 360px;
    grid-template-rows: 56px 1fr 48px;
    height: 100vh;
    width: 100vw;
    overflow: hidden;
    font-family: var(--dslw-font-sans);
    background: var(--dslw-background);
    color: var(--dslw-foreground);
  }

  .dslw-sidebar { grid-column: 1; grid-row: 1 / 4; overflow-y: auto; overflow-x: hidden; }
  .dslw-toolbar { grid-column: 2 / 4; grid-row: 1; }
  .dslw-canvas { grid-column: 2; grid-row: 2; overflow: hidden; position: relative; }
  .dslw-panel { grid-column: 3; grid-row: 1 / 3; overflow-y: auto; overflow-x: hidden; }
  .dslw-bottom { grid-column: 2 / 4; grid-row: 3; }

  /* ===== Sidebar ===== */
  .dslw-sidebar {
    background: var(--dslw-sidebar);
    border-right: 1px solid var(--dslw-sidebar-border);
    display: flex;
    flex-direction: column;
    padding: 16px 12px;
    gap: 4px;
  }
  .dslw-brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 4px 8px 16px;
  }
  .dslw-brand-logo {
    width: 28px; height: 28px;
    background: var(--dslw-sidebar-primary);
    border-radius: 6px;
    display: flex; align-items: center; justify-content: center;
    color: #fff;
    font-weight: 700;
    font-size: 14px;
    flex-shrink: 0;
  }
  .dslw-brand-text { display: flex; flex-direction: column; }
  .dslw-brand-name { font-size: 14px; font-weight: 600; color: var(--dslw-foreground); line-height: 1.2; }
  .dslw-brand-sub { font-size: 11px; color: var(--dslw-muted-foreground); margin-top: 2px; }

  .dslw-nav-section {
    font-size: 11px;
    font-weight: 500;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--dslw-muted-foreground);
    padding: 12px 8px 6px;
  }
  .dslw-nav-divider {
    height: 1px;
    background: var(--dslw-border);
    margin: 8px 4px;
  }

  .dslw-nav-item {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 40px;
    padding: 0 10px;
    border-radius: var(--dslw-radius-sm);
    font-size: 13px;
    color: var(--dslw-foreground);
    cursor: pointer;
    transition: background 0.15s;
    text-decoration: none;
    position: relative;
  }
  .dslw-nav-item:hover { background: var(--dslw-sidebar-accent); }
  .dslw-nav-item.active {
    background: var(--dslw-sidebar-primary);
    color: #fff;
  }
  .dslw-nav-item svg { width: 16px; height: 16px; flex-shrink: 0; }
  .dslw-nav-item .dslw-nav-badge {
    margin-left: auto;
    font-size: 11px;
    padding: 1px 7px;
    border-radius: 10px;
    background: rgba(255,255,255,0.2);
    color: #fff;
  }
  .dslw-nav-item:not(.active) .dslw-nav-badge-num {
    margin-left: auto;
    font-size: 11px;
    color: var(--dslw-muted-foreground);
    background: var(--dslw-muted);
    padding: 1px 7px;
    border-radius: 10px;
    min-width: 20px;
    text-align: center;
  }
  .dslw-nav-dot {
    margin-left: auto;
    width: 7px; height: 7px;
    border-radius: 50%;
    background: var(--dslw-destructive);
  }

  .dslw-project-card {
    margin: 4px;
    padding: 12px;
    border: 1px solid var(--dslw-border);
    border-radius: var(--dslw-radius-sm);
    background: #fff;
  }
  .dslw-project-name { font-size: 13px; font-weight: 600; color: var(--dslw-foreground); }
  .dslw-project-meta { font-size: 11px; color: var(--dslw-muted-foreground); margin-top: 6px; line-height: 1.5; }
  .dslw-project-warn { color: var(--dslw-warning-text); display: flex; align-items: center; gap: 4px; margin-top: 4px; font-size: 11px; }

  .dslw-sidebar-bottom {
    margin-top: auto;
    padding-top: 12px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .dslw-safe-mode {
    display: flex;
    align-items: flex-start;
    gap: 10px;
    padding: 10px;
    border-radius: var(--dslw-radius-sm);
    background: var(--dslw-muted);
  }
  .dslw-safe-mode-text { flex: 1; }
  .dslw-safe-mode-label { font-size: 12px; font-weight: 600; }
  .dslw-safe-mode-desc { font-size: 11px; color: var(--dslw-muted-foreground); margin-top: 2px; }

  /* Toggle switch */
  .dslw-toggle {
    position: relative;
    width: 32px; height: 18px;
    background: var(--dslw-border-strong);
    border-radius: 10px;
    cursor: pointer;
    transition: background 0.2s;
    flex-shrink: 0;
    margin-top: 2px;
  }
  .dslw-toggle::after {
    content: '';
    position: absolute;
    top: 2px; left: 2px;
    width: 14px; height: 14px;
    background: #fff;
    border-radius: 50%;
    transition: transform 0.2s;
    box-shadow: 0 1px 2px rgba(0,0,0,0.15);
  }
  .dslw-toggle.on { background: var(--dslw-primary); }
  .dslw-toggle.on::after { transform: translateX(14px); }

  .dslw-user-row {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px;
    border-radius: var(--dslw-radius-sm);
  }
  .dslw-avatar {
    width: 28px; height: 28px;
    border-radius: 50%;
    background: linear-gradient(135deg, #6b7280, #374151);
    flex-shrink: 0;
  }
  .dslw-user-info { flex: 1; }
  .dslw-user-name { font-size: 12px; font-weight: 500; }
  .dslw-user-status { font-size: 11px; color: var(--dslw-muted-foreground); }

  /* ===== Toolbar ===== */
  .dslw-toolbar {
    height: 56px;
    background: #fff;
    border-bottom: 1px solid var(--dslw-border);
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0 20px;
    gap: 12px;
  }
  .dslw-breadcrumb {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .dslw-breadcrumb a {
    color: var(--dslw-muted-foreground);
    text-decoration: none;
    transition: color 0.15s;
  }
  .dslw-breadcrumb a:hover { color: var(--dslw-foreground); }
  .dslw-breadcrumb .sep { color: var(--dslw-muted-foreground); opacity: 0.5; }
  .dslw-breadcrumb .current { color: var(--dslw-foreground); font-weight: 500; }
  .dslw-breadcrumb svg { width: 14px; height: 14px; color: var(--dslw-muted-foreground); }

  .dslw-toolbar-controls {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .dslw-zoom-group {
    display: flex;
    align-items: center;
    border: 1px solid var(--dslw-border);
    border-radius: var(--dslw-radius-sm);
    overflow: hidden;
  }
  .dslw-zoom-btn {
    width: 30px; height: 30px;
    display: flex; align-items: center; justify-content: center;
    background: #fff;
    border: none;
    cursor: pointer;
    color: var(--dslw-foreground);
    transition: background 0.15s;
  }
  .dslw-zoom-btn:hover { background: var(--dslw-muted); }
  .dslw-zoom-btn svg { width: 14px; height: 14px; }
  .dslw-zoom-val {
    width: 48px;
    height: 30px;
    display: flex; align-items: center; justify-content: center;
    font-size: 12px;
    font-family: var(--dslw-font-mono);
    border-left: 1px solid var(--dslw-border);
    border-right: 1px solid var(--dslw-border);
  }

  .dslw-segmented {
    display: flex;
    border: 1px solid var(--dslw-border);
    border-radius: var(--dslw-radius-sm);
    overflow: hidden;
  }
  .dslw-seg-btn {
    padding: 6px 14px;
    font-size: 12px;
    background: #fff;
    border: none;
    cursor: pointer;
    color: var(--dslw-muted-foreground);
    transition: all 0.15s;
    white-space: nowrap;
  }
  .dslw-seg-btn:hover { background: var(--dslw-muted); }
  .dslw-seg-btn.active {
    background: var(--dslw-primary);
    color: #fff;
  }

  .dslw-toolbar-divider {
    width: 1px;
    height: 24px;
    background: var(--dslw-border);
    margin: 0 4px;
  }

  .dslw-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 7px 14px;
    border-radius: var(--dslw-radius-sm);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    border: 1px solid transparent;
    transition: all 0.15s;
    white-space: nowrap;
    font-family: var(--dslw-font-sans);
  }
  .dslw-btn svg { width: 14px; height: 14px; }
  .dslw-btn-ghost {
    background: #fff;
    border-color: var(--dslw-border);
    color: var(--dslw-foreground);
  }
  .dslw-btn-ghost:hover { background: var(--dslw-muted); }
  .dslw-btn-primary {
    background: var(--dslw-primary);
    color: #fff;
    border-color: var(--dslw-primary);
  }
  .dslw-btn-primary:hover { background: #1f2937; }
  .dslw-btn-icon {
    width: 32px; height: 32px;
    padding: 0;
    display: flex; align-items: center; justify-content: center;
    background: #fff;
    border: 1px solid var(--dslw-border);
    border-radius: var(--dslw-radius-sm);
    cursor: pointer;
    color: var(--dslw-foreground);
    transition: background 0.15s;
  }
  .dslw-btn-icon:hover { background: var(--dslw-muted); }
  .dslw-btn-icon svg { width: 16px; height: 16px; }

  /* ===== Canvas ===== */
  .dslw-canvas {
    background: var(--dslw-canvas-bg);
    background-image:
      radial-gradient(circle, var(--dslw-canvas-grid) 1px, transparent 1px);
    background-size: 20px 20px;
  }
  .dslw-canvas-inner {
    position: relative;
    width: 100%;
    height: 100%;
    overflow: hidden;
  }
  .dslw-connections {
    position: absolute;
    top: 0; left: 0;
    width: 100%; height: 100%;
    pointer-events: none;
    z-index: 1;
  }
  .dslw-connections path {
    fill: none;
    stroke: var(--dslw-connection);
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .dslw-connections path.active {
    stroke: var(--dslw-connection-active);
    stroke-width: 2.5;
  }
  .dslw-connections path.flow {
    stroke-dasharray: 6 8;
    animation: dslw-flow 3s linear infinite;
  }
  .dslw-connections path.flow-active {
    stroke-dasharray: 6 8;
    animation: dslw-flow 2s linear infinite;
  }
  @keyframes dslw-flow {
    to { stroke-dashoffset: -28; }
  }

  /* Arrow markers */
  .dslw-connections defs .arrowhead { fill: var(--dslw-connection); }
  .dslw-connections defs .arrowhead-active { fill: var(--dslw-connection-active); }

  /* Nodes */
  .dslw-node {
    position: absolute;
    width: 180px;
    background: var(--dslw-node-bg);
    border: 1.5px solid var(--dslw-node-border);
    border-radius: var(--dslw-radius);
    padding: 14px;
    box-shadow: var(--dslw-shadow-sm);
    z-index: 2;
    transition: box-shadow 0.2s, border-color 0.2s;
    cursor: pointer;
  }
  .dslw-node:hover {
    box-shadow: var(--dslw-shadow);
    border-color: var(--dslw-border-strong);
  }
  .dslw-node.selected {
    border-color: var(--dslw-node-selected);
    border-width: 2px;
    box-shadow: 0 0 0 3px rgba(17,24,39,0.1), var(--dslw-shadow);
    transform: scale(1.02);
    z-index: 5;
  }
  .dslw-node.focus {
    border-left: 3px solid var(--dslw-primary);
    border-color: var(--dslw-primary);
    animation: dslw-pulse 3s ease-in-out infinite;
  }
  @keyframes dslw-pulse {
    0%, 100% { box-shadow: var(--dslw-shadow-sm), 0 0 0 0 rgba(17,24,39,0.15); }
    50% { box-shadow: var(--dslw-shadow-sm), 0 0 0 6px rgba(17,24,39,0); }
  }

  .dslw-node-status {
    display: flex;
    align-items: center;
    gap: 5px;
    font-size: 11px;
    margin-bottom: 8px;
  }
  .dslw-status-dot {
    width: 7px; height: 7px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .dslw-status-dot.ok { background: var(--dslw-success); }
  .dslw-status-dot.warn { background: var(--dslw-warning); }
  .dslw-status-dot.info { background: var(--dslw-info); }
  .dslw-status-dot.gray { background: var(--dslw-chart-2); }
  .dslw-status-dot.focus-dot { background: var(--dslw-primary); }
  .dslw-status-text { font-weight: 500; }
  .dslw-status-text.ok { color: var(--dslw-success-text); }
  .dslw-status-text.warn { color: var(--dslw-warning-text); }
  .dslw-status-text.info { color: var(--dslw-info-text); }
  .dslw-status-text.gray { color: var(--dslw-muted-foreground); }
  .dslw-status-text.focus-text { color: var(--dslw-primary); }

  .dslw-node-title-row {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .dslw-node-icon {
    width: 28px; height: 28px;
    border-radius: 6px;
    background: var(--dslw-muted);
    display: flex; align-items: center; justify-content: center;
    flex-shrink: 0;
    color: var(--dslw-foreground);
  }
  .dslw-node.selected .dslw-node-icon { background: var(--dslw-warning-subtle); color: var(--dslw-warning-text); }
  .dslw-node.focus .dslw-node-icon { background: var(--dslw-primary); color: #fff; }
  .dslw-node-icon svg { width: 14px; height: 14px; }
  .dslw-node-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--dslw-foreground);
    line-height: 1.2;
  }

  .dslw-node-desc {
    font-size: 12px;
    color: var(--dslw-muted-foreground);
    line-height: 1.5;
    margin-bottom: 10px;
  }

  .dslw-node-footer {
    display: flex;
    align-items: center;
    font-size: 11px;
  }
  .dslw-badge {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    padding: 3px 8px;
    border-radius: 10px;
    font-size: 11px;
    font-weight: 500;
    line-height: 1;
  }
  .dslw-badge-ok { background: var(--dslw-success-subtle); color: var(--dslw-success-text); }
  .dslw-badge-warn { background: var(--dslw-warning-subtle); color: var(--dslw-warning-text); }
  .dslw-badge-info { background: var(--dslw-info-subtle); color: var(--dslw-info-text); }
  .dslw-badge-gray { background: var(--dslw-muted); color: var(--dslw-muted-foreground); }
  .dslw-badge-dark { background: var(--dslw-primary); color: #fff; }

  /* Minimap */
  .dslw-minimap-wrap {
    position: absolute;
    bottom: 16px;
    left: 16px;
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .dslw-minimap {
    width: 140px;
    height: 100px;
    background: #fff;
    border: 1px solid var(--dslw-border);
    border-radius: var(--dslw-radius-sm);
    box-shadow: var(--dslw-shadow-xs);
    position: relative;
    overflow: hidden;
  }
  .dslw-minimap .mm-node {
    position: absolute;
    width: 8px; height: 6px;
    border-radius: 1.5px;
  }
  .dslw-minimap .mm-viewport {
    position: absolute;
    border: 1.5px solid var(--dslw-primary);
    background: rgba(17,24,39,0.06);
    border-radius: 2px;
  }

  .dslw-legend {
    display: flex;
    gap: 10px;
    font-size: 11px;
    color: var(--dslw-muted-foreground);
    background: #fff;
    padding: 6px 10px;
    border-radius: var(--dslw-radius-sm);
    border: 1px solid var(--dslw-border);
    box-shadow: var(--dslw-shadow-xs);
    width: fit-content;
  }
  .dslw-legend-item { display: flex; align-items: center; gap: 4px; }
  .dslw-legend-dot { width: 7px; height: 7px; border-radius: 50%; }

  /* Canvas controls */
  .dslw-canvas-ctrls {
    position: absolute;
    bottom: 16px;
    right: 16px;
    z-index: 10;
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .dslw-canvas-ctrl {
    width: 32px; height: 32px;
    background: #fff;
    border: 1px solid var(--dslw-border);
    border-radius: var(--dslw-radius-sm);
    display: flex; align-items: center; justify-content: center;
    cursor: pointer;
    box-shadow: var(--dslw-shadow-xs);
    color: var(--dslw-foreground);
    transition: background 0.15s;
    font-size: 13px;
    font-weight: 600;
  }
  .dslw-canvas-ctrl:hover { background: var(--dslw-muted); }
  .dslw-canvas-ctrl svg { width: 15px; height: 15px; }

  /* ===== Detail Panel ===== */
  .dslw-panel {
    background: #fff;
    border-left: 1px solid var(--dslw-border);
    display: flex;
    flex-direction: column;
    animation: dslw-slide-in 0.3s ease-out;
  }
  @keyframes dslw-slide-in {
    from { transform: translateX(100%); opacity: 0; }
    to { transform: translateX(0); opacity: 1; }
  }
  .dslw-panel-header {
    padding: 20px 20px 16px;
    border-bottom: 1px solid var(--dslw-border);
    position: relative;
    flex-shrink: 0;
  }
  .dslw-panel-close {
    position: absolute;
    top: 16px; right: 16px;
    width: 28px; height: 28px;
    display: flex; align-items: center; justify-content: center;
    border: none;
    background: transparent;
    border-radius: var(--dslw-radius-sm);
    cursor: pointer;
    color: var(--dslw-muted-foreground);
    transition: background 0.15s, color 0.15s;
  }
  .dslw-panel-close:hover { background: var(--dslw-muted); color: var(--dslw-foreground); }
  .dslw-panel-close svg { width: 16px; height: 16px; }

  .dslw-panel-badge { margin-bottom: 10px; }
  .dslw-panel-title {
    font-size: 18px;
    font-weight: 600;
    color: var(--dslw-foreground);
    margin-bottom: 4px;
  }
  .dslw-panel-subtitle {
    font-size: 13px;
    color: var(--dslw-muted-foreground);
    line-height: 1.5;
  }

  .dslw-explain-card {
    margin-top: 14px;
    background: var(--dslw-muted);
    border-radius: 8px;
    padding: 12px;
  }
  .dslw-explain-title {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--dslw-muted-foreground);
    margin-bottom: 6px;
  }
  .dslw-explain-body {
    font-size: 13px;
    line-height: 1.65;
    color: var(--dslw-foreground);
  }
  .dslw-explain-body + .dslw-explain-title { margin-top: 10px; }

  /* Tabs */
  .dslw-tabs {
    display: flex;
    border-bottom: 1px solid var(--dslw-border);
    padding: 0 16px;
    flex-shrink: 0;
    background: #fff;
    position: sticky;
    top: 0;
    z-index: 2;
  }
  .dslw-tab {
    padding: 12px 4px;
    margin-right: 20px;
    font-size: 13px;
    font-weight: 500;
    color: var(--dslw-muted-foreground);
    border: none;
    background: transparent;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    transition: color 0.15s, border-color 0.15s;
    white-space: nowrap;
    font-family: var(--dslw-font-sans);
  }
  .dslw-tab:hover { color: var(--dslw-foreground); }
  .dslw-tab.active {
    color: var(--dslw-foreground);
    border-bottom-color: var(--dslw-primary);
  }

  .dslw-panel-body {
    flex: 1;
    overflow-y: auto;
    padding: 16px 20px;
  }

  /* Issue cards */
  .dslw-issue {
    border-left: 3px solid var(--dslw-warning);
    background: #fff;
    border-radius: 0 var(--dslw-radius-sm) var(--dslw-radius-sm) 0;
    padding: 12px 14px;
    margin-bottom: 10px;
    box-shadow: var(--dslw-shadow-xs);
    border-top: 1px solid var(--dslw-border);
    border-right: 1px solid var(--dslw-border);
    border-bottom: 1px solid var(--dslw-border);
  }
  .dslw-issue.severe { border-left-color: var(--dslw-destructive); }
  .dslw-issue-head {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-bottom: 6px;
  }
  .dslw-issue-title {
    font-size: 13px;
    font-weight: 600;
    color: var(--dslw-foreground);
  }
  .dslw-issue-desc {
    font-size: 12px;
    color: var(--dslw-muted-foreground);
    line-height: 1.55;
    margin-bottom: 10px;
  }
  .dslw-issue-actions {
    display: flex;
    gap: 6px;
  }
  .dslw-issue-btn {
    padding: 4px 10px;
    font-size: 11px;
    border-radius: var(--dslw-radius-sm);
    cursor: pointer;
    border: 1px solid var(--dslw-border);
    background: #fff;
    color: var(--dslw-muted-foreground);
    transition: all 0.15s;
    font-family: var(--dslw-font-sans);
    font-weight: 500;
  }
  .dslw-issue-btn:hover { background: var(--dslw-muted); color: var(--dslw-foreground); }
  .dslw-issue-btn.primary {
    background: var(--dslw-primary);
    color: #fff;
    border-color: var(--dslw-primary);
  }
  .dslw-issue-btn.primary:hover { background: #1f2937; }

  /* Params tab */
  .dslw-param {
    margin-bottom: 16px;
  }
  .dslw-param-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 4px;
  }
  .dslw-param-label { font-size: 13px; font-weight: 500; }
  .dslw-param-desc { font-size: 11px; color: var(--dslw-muted-foreground); margin-bottom: 6px; }
  .dslw-param-input {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .dslw-input {
    padding: 6px 10px;
    border: 1px solid var(--dslw-border);
    border-radius: var(--dslw-radius-sm);
    font-size: 13px;
    font-family: var(--dslw-font-mono);
    width: 80px;
    outline: none;
    transition: border-color 0.15s;
    background: #fff;
  }
  .dslw-input:focus { border-color: var(--dslw-primary); }
  .dslw-select {
    padding: 6px 24px 6px 10px;
    border: 1px solid var(--dslw-border);
    border-radius: var(--dslw-radius-sm);
    font-size: 13px;
    background: #fff;
    outline: none;
    cursor: pointer;
    font-family: var(--dslw-font-sans);
    appearance: none;
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 24 24' fill='none' stroke='%2371717a' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpolyline points='6 9 12 15 18 9'%3E%3C/polyline%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: right 6px center;
  }
  .dslw-slider {
    flex: 1;
    -webkit-appearance: none;
    appearance: none;
    height: 4px;
    background: var(--dslw-border);
    border-radius: 2px;
    outline: none;
  }
  .dslw-slider::-webkit-slider-thumb {
    -webkit-appearance: none;
    width: 14px; height: 14px;
    border-radius: 50%;
    background: var(--dslw-primary);
    cursor: pointer;
  }
  .dslw-param-toggle-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  /* Code blocks */
  .dslw-codeblock {
    background: var(--dslw-muted);
    border-radius: 8px;
    padding: 12px;
    font-family: var(--dslw-font-mono);
    font-size: 12px;
    line-height: 1.6;
    color: var(--dslw-foreground);
    overflow-x: auto;
    margin-bottom: 12px;
    white-space: pre;
  }
  .dslw-code-label {
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--dslw-muted-foreground);
    margin-bottom: 6px;
    margin-top: 8px;
  }

  /* Panel feedback */
  .dslw-feedback {
    border-top: 1px solid var(--dslw-border);
    padding: 14px 20px 16px;
    background: #fff;
    flex-shrink: 0;
  }
  .dslw-feedback-title {
    font-size: 12px;
    font-weight: 600;
    margin-bottom: 10px;
  }
  .dslw-feedback-actions {
    display: flex;
    gap: 6px;
    margin-bottom: 10px;
  }
  .dslw-fb-btn {
    padding: 5px 12px;
    font-size: 12px;
    border: 1px solid var(--dslw-border);
    border-radius: var(--dslw-radius-sm);
    background: #fff;
    color: var(--dslw-muted-foreground);
    cursor: pointer;
    transition: all 0.15s;
    font-family: var(--dslw-font-sans);
    font-weight: 500;
  }
  .dslw-fb-btn:hover { background: var(--dslw-muted); color: var(--dslw-foreground); }
  .dslw-fb-btn.active {
    background: var(--dslw-primary);
    color: #fff;
    border-color: var(--dslw-primary);
  }
  .dslw-feedback-textarea {
    width: 100%;
    border: 1px solid var(--dslw-border);
    border-radius: var(--dslw-radius-sm);
    padding: 10px;
    font-size: 13px;
    font-family: var(--dslw-font-sans);
    resize: none;
    outline: none;
    min-height: 72px;
    line-height: 1.5;
    color: var(--dslw-foreground);
    background: #fff;
    transition: border-color 0.15s;
  }
  .dslw-feedback-textarea:focus { border-color: var(--dslw-primary); }
  .dslw-feedback-textarea::placeholder { color: var(--dslw-muted-foreground); }
  .dslw-feedback-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-top: 8px;
  }
  .dslw-feedback-hint {
    font-size: 11px;
    color: var(--dslw-muted-foreground);
  }
  .dslw-feedback-send {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    padding: 7px 14px;
    background: var(--dslw-primary);
    color: #fff;
    border: none;
    border-radius: var(--dslw-radius-sm);
    font-size: 12px;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.15s;
    font-family: var(--dslw-font-sans);
  }
  .dslw-feedback-send:hover { background: #1f2937; }
  .dslw-feedback-send svg { width: 14px; height: 14px; }

  /* ===== Bottom Bar ===== */
  .dslw-bottom {
    height: 48px;
    background: #fff;
    border-top: 1px solid var(--dslw-border);
    display: flex;
    align-items: center;
    padding: 0 20px;
    gap: 16px;
  }
  .dslw-slider-wrap {
    flex: 1;
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: 700px;
    margin: 0 auto;
  }
  .dslw-slider-label {
    font-size: 12px;
    color: var(--dslw-muted-foreground);
    white-space: nowrap;
    min-width: 60px;
  }
  .dslw-slider-label.right { text-align: right; }
  .dslw-slider-track {
    flex: 1;
    height: 4px;
    background: var(--dslw-border);
    border-radius: 2px;
    position: relative;
    cursor: pointer;
  }
  .dslw-slider-thumb {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 40px;
    height: 26px;
    background: var(--dslw-primary);
    border-radius: 6px;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 2px;
    cursor: grab;
    box-shadow: var(--dslw-shadow-sm);
    transition: transform 0.15s;
  }
  .dslw-slider-thumb:hover { transform: translate(-50%, -50%) scale(1.05); }
  .dslw-slider-thumb svg { width: 12px; height: 12px; color: #fff; }
  .dslw-slider-hint {
    font-size: 12px;
    color: var(--dslw-muted-foreground);
    text-align: center;
    white-space: nowrap;
    min-width: 180px;
  }
  .dslw-version-info {
    display: flex;
    align-items: center;
    gap: 8px;
    font-size: 12px;
    color: var(--dslw-muted-foreground);
    margin-left: auto;
    white-space: nowrap;
  }
  .dslw-version-arrow { color: var(--dslw-foreground); font-weight: 500; }
  .dslw-change-count {
    font-size: 11px;
    padding: 2px 8px;
    border-radius: 10px;
    background: var(--dslw-primary);
    color: #fff;
    font-weight: 500;
  }
`;
