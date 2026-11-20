// Sidebar for people who belong to a Fleet Partner account. What shows depends on the role (see FleetPermissions).
import React, { useEffect } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Car, Users, Route, Receipt, UserCog, Settings, LogOut, X, Truck } from 'lucide-react';
import { useUIStore } from '@/store/uiStore';
import { useAuthStore } from '@/store/authStore';
import { fleetPortalAPI } from '@/services/api/fleetPortal';
import { FLEET_ROLE_LABEL } from '@/types/fleetPortal';
import { cn } from '@/utils/helpers';
import logo from '@/assets/images/runserv_light.png';

const FleetSidebar: React.FC = () => {
  const { sidebarOpen, setSidebarOpen, isMobile } = useUIStore();
  const { user, logout, setUser } = useAuthStore();
  const navigate = useNavigate();
  const f = user?.fleet;
  const p = f?.permissions;

  // Keep role, permissions and account status current (an owner can change a role; Runserv can suspend a fleet).
  useEffect(() => {
    const load = () => fleetPortalAPI.profile().then((x) => {
      const cur = useAuthStore.getState().user;
      if (!cur?.fleet || !x?.fleetPartner) return;
      const next = { id: x.fleetPartner.id, name: x.fleetPartner.tradingName || x.fleetPartner.legalName, status: x.fleetPartner.status, verificationStatus: x.fleetPartner.verificationStatus, role: x.role, permissions: x.permissions };
      if (JSON.stringify(next) !== JSON.stringify(cur.fleet)) setUser({ ...cur, fleet: next });
    }).catch(() => {});
    load(); const t = setInterval(load, 60_000); return () => clearInterval(t);
  }, [setUser]);

  const nav = [
    { name: 'Overview', href: '/', icon: LayoutDashboard, end: true, show: true },
    { name: 'Vehicles', href: '/fleet/vehicles', icon: Car, show: true },
    { name: 'Drivers', href: '/fleet/drivers', icon: Users, show: !!(p?.assignDrivers || p?.seeDriverIdentity) },
    { name: 'Trips', href: '/fleet/trips', icon: Route, show: !!p?.seeTrips },
    { name: 'Settlements', href: '/fleet/settlements', icon: Receipt, show: !!p?.seeFinance },
    { name: 'Team', href: '/fleet/team', icon: UserCog, show: !!p?.manageUsers },
    { name: 'Settings', href: '/fleet/settings', icon: Settings, show: !!p?.manageSettings },
  ].filter((n) => n.show);
  const close = () => setSidebarOpen(false);

  return (
    <>
      {isMobile && sidebarOpen && <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-20" onClick={close} />}
      <aside data-testid="fleet-sidebar" className={cn('flex flex-col z-30 transition-all duration-300 bg-[#0f1623]', isMobile ? 'fixed inset-y-0 left-0' : 'relative', sidebarOpen ? 'w-[232px]' : isMobile ? '-translate-x-full' : 'w-0 overflow-hidden')}>
        <div className="h-0.5 w-full bg-primary-500 flex-shrink-0" />
        <div className="flex items-center justify-between h-14 px-4 flex-shrink-0">
          <img src={logo} alt="Runserv" className="h-7 w-auto" />
          {isMobile && <button onClick={close} className="w-7 h-7 flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/10"><X className="h-4 w-4" /></button>}
        </div>
        <div className="mx-3 mb-2 px-3 py-2.5 rounded-xl bg-white/5 border border-white/10 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary-600 flex items-center justify-center flex-shrink-0"><Truck className="h-4 w-4 text-white" /></div>
            <div className="min-w-0"><p className="text-sm font-semibold text-white truncate leading-tight">{f?.name}</p>
              <p className="text-[11px] text-white/50 mt-0.5">Fleet partner · {f ? FLEET_ROLE_LABEL[f.role] : ''}</p></div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {nav.map((item) => (
            <NavLink key={item.href} to={item.href} end={item.end} onClick={() => isMobile && close()}
              className={({ isActive }) => cn('flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all mb-0.5 group', isActive ? 'bg-white/10 text-white' : 'text-white/60 hover:bg-white/10 hover:text-white/90')}>
              <span className="flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0 group-hover:bg-white/10"><item.icon className="h-4 w-4" /></span>
              <span className="flex-1">{item.name}</span>
            </NavLink>))}
        </nav>
        <div className="px-3 pb-4 flex-shrink-0">
          <button onClick={() => { logout(); navigate('/login'); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-white/50 hover:bg-white/10 hover:text-white/90 transition-colors"><LogOut className="h-4 w-4" /> Sign out</button>
        </div>
      </aside>
    </>
  );
};
export default FleetSidebar;
