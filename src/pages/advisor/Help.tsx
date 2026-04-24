import { BookOpen, HelpCircle, FileText } from 'lucide-react';

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
            <p>Kullanım kılavuzu içeriği burada gösterilecek</p>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <HelpCircle size={20} />
            <h3>Sık Sorulan Sorular</h3>
          </div>
          <div className="card-body">
            <p>SSS listesi burada gösterilecek</p>
          </div>
        </div>

        <div className="card">
          <div className="card-header">
            <FileText size={20} />
            <h3>Sistem Versiyon Notları</h3>
          </div>
          <div className="card-body">
            <p>Sistem versiyon notları ve güncellemeler burada listelenecek</p>
          </div>
        </div>
      </div>
    </div>
  );
}
