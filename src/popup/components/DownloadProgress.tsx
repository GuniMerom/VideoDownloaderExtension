import type { DownloadTask } from '../../shared/types';

interface DownloadProgressProps {
  tasks: DownloadTask[];
}

const STATUS_LABELS: Record<DownloadTask['status'], string> = {
  pending: 'Waiting...',
  downloading: 'Downloading',
  muxing: 'Muxing audio & video...',
  complete: 'Complete',
  error: 'Error',
};

function statusClass(status: DownloadTask['status']): string {
  switch (status) {
    case 'complete':
      return 'status-complete';
    case 'error':
      return 'status-error';
    case 'downloading':
    case 'muxing':
      return 'status-active';
    default:
      return 'status-pending';
  }
}

export function DownloadProgress({ tasks }: DownloadProgressProps) {
  if (tasks.length === 0) return null;

  return (
    <div class="download-progress-section">
      <h2 class="section-title">
        <span class="section-icon">⬇</span> Downloads
      </h2>
      <div class="download-list">
        {tasks.map((task) => (
          <div class={`download-item ${statusClass(task.status)}`} key={task.id}>
            <div class="download-item-header">
              <span class="download-title">
                {task.status === 'complete' && <span class="check-icon">✓ </span>}
                {task.status === 'error' && <span class="error-icon">✕ </span>}
                {task.videoInfo.title}
              </span>
              <span class={`download-status ${statusClass(task.status)}`}>
                {STATUS_LABELS[task.status]}
              </span>
            </div>

            {(task.status === 'downloading' || task.status === 'muxing' || task.status === 'pending') && (
              <div class="progress-bar-container">
                <div
                  class="progress-bar"
                  style={{ width: `${Math.min(task.progress, 100)}%` }}
                />
                <span class="progress-text">{Math.round(task.progress)}%</span>
              </div>
            )}

            {task.status === 'error' && task.error && (
              <p class="download-error">{task.error}</p>
            )}

            {task.status === 'complete' && task.completionMessage && (
              <p class="download-status-note">{task.completionMessage}</p>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
