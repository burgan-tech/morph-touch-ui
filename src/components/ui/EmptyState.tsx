import { Inbox } from 'lucide-react';

interface EmptyStateProps {
  message?: string;
  icon?: React.ReactNode;
}

export function EmptyState({ message = 'Veri bulunamadı', icon }: EmptyStateProps) {
  return (
    <div className="empty-state">
      {icon || <Inbox size={40} strokeWidth={1.5} />}
      <p>{message}</p>
    </div>
  );
}
