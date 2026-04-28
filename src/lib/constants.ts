export type Role = 'advisor' | 'admin' | 'audit' | 'customer';

export const ROLE_LABELS: Record<Role, string> = {
  advisor: 'Yetkili Kullanıcı',
  admin: 'Admin',
  audit: 'Audit',
  customer: 'Müşteri',
};

export const ADVISOR_MENU = [
  { key: 'dashboard', label: 'Dashboard', icon: 'LayoutDashboard' },
  { key: 'chat', label: 'Chat Yönetimi', icon: 'MessageSquare' },
  { key: 'appointments', label: 'Randevu Yönetimi', icon: 'CalendarDays' },
  { key: 'absence', label: 'İzin & Çalışma Durumum', icon: 'CalendarOff' },
  { key: 'help', label: 'Yardım & Destek', icon: 'HelpCircle' },
] as const;

export const ADMIN_MENU = [
  { key: 'dashboard', label: 'Dashboard', icon: 'LayoutDashboard' },
  { key: 'staff', label: 'Personel Yönetimi', icon: 'Users' },
  { key: 'settings', label: 'Çalışma Saatleri Yönetimi', icon: 'Settings' },
  { key: 'help', label: 'Yardım & Destek', icon: 'HelpCircle' },
] as const;

export const AUDIT_MENU = [
  { key: 'dashboard', label: 'Dashboard', icon: 'LayoutDashboard' },
  { key: 'video-records', label: 'Görüntülü Görüşme Kaydı', icon: 'Video' },
  { key: 'chat-records', label: 'Chat Yazışmaları', icon: 'MessageSquare' },
] as const;

export const CUSTOMER_MENU = [
  { key: 'dashboard', label: 'Dashboard', icon: 'LayoutDashboard' },
  { key: 'chat', label: 'Sohbet', icon: 'MessageSquare' },
] as const;

export const STATUS_OPTIONS = [
  { value: 'online', label: 'Uygun', color: '#22c55e' },
  { value: 'busy', label: 'Meşgul', color: '#ef4444' },
  { value: 'away', label: 'Uzakta', color: '#f59e0b' },
  { value: 'offline', label: 'Çevrimdışı', color: '#6b7280' },
] as const;

export const STATE_LABELS: Record<string, string> = {
  draft: 'Taslak',
  online: 'Çevrimiçi',
  offline: 'Çevrimdışı',
  busy: 'Meşgul',
  away: 'Uzakta',
  active: 'Aktif',
  'in-meet': 'Görüşmede',
  'meet-completed': 'Tamamlandı',
  'user-cancelled': 'Müşteri İptali',
  'advisor-cancelled': 'Danışman İptali',
  timeout: 'Zaman Aşımı',
  complete: 'Tamamlandı',
  cancelled: 'İptal',
  'awaiting-assignment': 'Atama Bekliyor',
  'awaiting-permanent-assignment': 'Kalıcı Oda Ataması Bekliyor',
  completed: 'Tamamlandı',
  creating: 'Oluşturuluyor',
  failed: 'Başarısız',
};

export const DAY_LABELS: Record<string, string> = {
  monday: 'Pazartesi',
  tuesday: 'Salı',
  wednesday: 'Çarşamba',
  thursday: 'Perşembe',
  friday: 'Cuma',
  saturday: 'Cumartesi',
  sunday: 'Pazar',
};
