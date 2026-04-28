import { BookOpen, HelpCircle, FileText, Mail } from 'lucide-react';

export function Help() {
  return (
    <div className="page">
      <div className="page-header">
        <h1>Yardım & Destek</h1>
      </div>
      <div className="page-grid">
        <div className="card">
          <div className="card-header">
            <BookOpen size={20} />
            <h3>Kullanım Kılavuzu</h3>
          </div>
          <div className="card-body">
            <p className="text-muted">Placeholder content</p>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <HelpCircle size={20} />
            <h3>SSS</h3>
          </div>
          <div className="card-body">
            <p className="text-muted">Placeholder content</p>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <FileText size={20} />
            <h3>Versiyon Notları</h3>
          </div>
          <div className="card-body">
            <p className="text-muted">Placeholder content</p>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <Mail size={20} />
            <h3>İletişim Bilgileri</h3>
          </div>
          <div className="card-body">
            <p className="text-muted">Placeholder content</p>
          </div>
        </div>
      </div>
    </div>
  );
}
