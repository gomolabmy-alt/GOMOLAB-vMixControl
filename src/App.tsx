import { useEffect } from 'react';
import { useVmixStore } from './stores/vmixStore';
import { TitleBar } from './components/TitleBar';
import { StatusBar } from './components/StatusBar';
import { Canvas } from './components/Canvas';

export function App() {
  const { connect, connectionStatus, savedConnections } = useVmixStore();

  useEffect(() => {
    if (connectionStatus === 'disconnected' && savedConnections.length > 0) {
      const last = [...savedConnections].sort((a, b) => (b.lastConnected ?? 0) - (a.lastConnected ?? 0))[0];
      connect({ host: last.host, port: last.port });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="app-layout">
      <TitleBar />
      <StatusBar />
      <Canvas />
    </div>
  );
}
