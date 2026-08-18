import type { LucideIcon } from 'lucide-react';
import { Hexagon, ArrowLeftRight, Music, CircleDot, Zap, Database } from 'lucide-react';
import { useVmixStore } from '../stores/vmixStore';

const TABS: { label: string; icon: LucideIcon }[] = [
  { label: 'Inputs',    icon: Hexagon },
  { label: 'Mix',       icon: ArrowLeftRight },
  { label: 'Audio',     icon: Music },
  { label: 'Scores',    icon: CircleDot },
  { label: 'Shortcuts', icon: Zap },
  { label: 'Data',      icon: Database },
];

export function TabBar() {
  const { activeTab, setActiveTab } = useVmixStore();
  return (
    <nav className="tab-bar">
      {TABS.map((tab, i) => (
        <button
          key={tab.label}
          className={`tab-btn ${activeTab === i ? 'tab-btn--active' : ''}`}
          onClick={() => setActiveTab(i)}
        >
          <span className="tab-icon"><tab.icon size={14} strokeWidth={2} /></span>
          <span className="tab-label">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
