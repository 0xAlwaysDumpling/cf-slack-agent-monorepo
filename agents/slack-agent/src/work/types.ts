export type WorkItemType = "task" | "plan";

export type WorkItemStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export interface WorkItem {
  id: string;
  type: WorkItemType;
  devAgentId: string;
  repo: string;
  description: string;
  status: WorkItemStatus;
  outcome?: string;
  prUrl?: string;
  branchName?: string;
  channel: string;
  threadTs: string;
  teamId: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  error?: string;
  summary?: string;
}

export interface TrackWorkInput {
  type: WorkItemType;
  devAgentId: string;
  repo: string;
  description: string;
  channel: string;
  threadTs: string;
  teamId: string;
  createdBy?: string;
}

export interface UpdateWorkInput {
  status?: WorkItemStatus;
  outcome?: string;
  prUrl?: string;
  branchName?: string;
  error?: string;
  summary?: string;
}

export interface WorkSearchOptions {
  repo?: string;
  status?: WorkItemStatus;
  type?: WorkItemType;
  channel?: string;
  createdBy?: string;
  query?: string;
  limit?: number;
  offset?: number;
}

export interface CallbackPayload {
  type: "task_completed" | "plan_step_completed";
  taskId: string;
  planId: string | null;
  repo: string;
  status: string;
  outcome: string | null;
  prUrl: string | null;
  branchName: string | null;
  summary: string | null;
  error: string | null;
}
