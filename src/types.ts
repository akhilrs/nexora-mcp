export interface WorkItem {
  id: string;
  organization_id: string;
  project_id: string;
  display_id: string;
  parent_id: string | null;
  item_type: 'epic' | 'story' | 'task' | 'bug' | 'feature';
  title: string;
  description: string | null;
  status: 'backlog' | 'todo' | 'in_progress' | 'in_review' | 'completed' | 'wont_do';
  priority: number;
  assigned_to_id: string | null;
  milestone_id: string | null;
  stream_id: string | null;
  due_date: string | null;
  estimated_hours: number | null;
  tags: string[] | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface Comment {
  id: string;
  organization_id: string;
  work_item_id: string | null;
  message_id: string | null;
  content: string;
  author_id: string;
  parent_comment_id: string | null;
  is_ai_generated: boolean;
  is_internal: boolean;
  created_at: string;
  updated_at: string;
}

export interface Project {
  id: string;
  organization_id: string;
  name: string;
  description: string | null;
  code: string;
  status: 'planning' | 'active' | 'paused' | 'completed' | 'archived';
  start_date: string | null;
  target_end_date: string | null;
  project_lead_id: string | null;
  priority: number;
  created_at: string;
  updated_at: string;
}

export interface TimeEntry {
  id: string;
  organization_id: string;
  project_id: string;
  work_item_id: string | null;
  employee_id: string;
  date: string;
  duration_minutes: number;
  started_at: string | null;
  ended_at: string | null;
  is_running: boolean;
  is_manual: boolean;
  is_billable: boolean;
  description: string | null;
  approval_status: 'pending' | 'approved' | 'rejected';
  created_at: string;
  updated_at: string;
}

export interface Stream {
  id: string;
  organization_id: string;
  project_id: string;
  name: string;
  description: string | null;
  status: 'active' | 'paused' | 'completed' | 'archived';
  color_code: string | null;
  position: number;
  created_at: string;
  updated_at: string;
}

export interface Dependency {
  id: string;
  organization_id: string;
  work_item_id: string;
  depends_on_id: string;
  dependency_type: 'blocks' | 'relates_to';
  created_at: string;
}

export interface PaginatedResponse<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
}

export interface ActivityLogEntry {
  id: string;
  module: string;
  actor_id: string | null;
  action: string;
  entity_type: string;
  entity_id: string;
  summary: string;
  created_at: string;
}
