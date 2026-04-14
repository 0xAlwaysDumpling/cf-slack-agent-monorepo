export interface ReportConfig {
  id: string;
  name: string;
  schedule: string;
  channel: string;
  promptKey: string;
  enabled: boolean;
}

export interface ReportResult {
  reportId: string;
  text: string;
  toolsUsed: string[];
  durationMs: number;
}
