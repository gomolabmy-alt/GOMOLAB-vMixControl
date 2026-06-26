import { useVmixStore } from '../stores/vmixStore';

const TABS = [
  { label: 'Inputs',    icon: '⬡' },
  { label: 'Mix',       icon: '⇄' },
  { label: 'Audio',     icon: '♪' },
  { label: 'Scores',    icon: '⚽' },
  { label: 'Shortcuts', icon: '⚡' },
  { label: 'Data',      icon: '⊕' },
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
          <span className="tab-icon">{tab.icon}</span>
          <span className="tab-label">{tab.label}</span>
        </button>
      ))}
    </nav>
  );
}
