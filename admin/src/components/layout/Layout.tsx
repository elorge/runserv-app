// admin-web/src/components/layout/Layout.tsx
import React, { useEffect } from 'react';
import { useUIStore } from '@/store/uiStore';
import Sidebar from './Sidebar';
import CompanySidebar from './CompanySidebar';
import FleetSidebar from './FleetSidebar';
import { useAuthStore } from '@/store/authStore';
import Header from './Header';

interface LayoutProps {
  children: React.ReactNode;
}

const Layout: React.FC<LayoutProps> = ({ children }) => {
  const { setIsMobile } = useUIStore();
  const isCompany = !!useAuthStore(s => s.user?.company);
  const isFleet   = !!useAuthStore(s => s.user?.fleet);

  useEffect(() => {
    const handleResize = () => setIsMobile(window.innerWidth < 768);
    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, [setIsMobile]);

  return (
    <div className="flex h-screen bg-gray-100">
      {isCompany ? <CompanySidebar /> : isFleet ? <FleetSidebar /> : <Sidebar />}

      <div className="flex-1 flex flex-col overflow-hidden">
        <Header />

        <main className="flex-1 overflow-y-auto bg-gray-50 p-6">
          <div className="max-w-7xl mx-auto">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};

export default Layout;