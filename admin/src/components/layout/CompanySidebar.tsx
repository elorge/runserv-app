// Sidebar for people with an organisation role. What shows depends on the role (see the permissions).
import React, { useEffect, useState } from 'react';
import { NavLink, useNavigate } from 'react-router-dom';
import { LayoutDashboard, Users, Route, CalendarCheck, Receipt, Settings, LogOut, X, Download, Building2, Network, BookUser } from 'lucide-react';
import { useUIStore } from '@/store/uiStore';
import { useAuthStore } from '@/store/authStore';
import { useBrandStore } from '@/store/brandStore';
import { companyAPI } from '@/services/api/company';
import { usePwaInstall } from '@/hooks/usePwaInstall';
import { ROLE_LABEL } from '@/types/company';
import { cn } from '@/utils/helpers';
import logo from '@/assets/images/runserv_light.png';

const CompanySidebar: React.FC = () => {
  const { sidebarOpen, setSidebarOpen, isMobile } = useUIStore();
  const { user, logout } = useAuthStore();
  const brand = useBrandStore((s) => s.brand);
  const navigate = useNavigate();
  const { canInstall, install } = usePwaInstall();
  const [counts, setCounts] = useState({ requests: 0, approvals: 0 });
  const p = user?.company?.permissions;

  useEffect(() => {
    const load = () => companyAPI.profile().then((x) => setCounts({ requests: x.pendingRequests, approvals: x.pendingApprovals + x.pendingWeekend })).catch(() => {});
    load(); const t = setInterval(load, 60_000); return () => clearInterval(t);
  }, []);

  const nav = [
    { name: 'Overview', href: '/', icon: LayoutDashboard, end: true, show: true },
    { name: p?.manageStaff ? 'Staff' : 'My team', href: '/company/staff', icon: Users, badge: counts.requests, show: true },
    { name: 'Departments', href: '/company/departments', icon: Network, show: true },
    { name: 'Staff directory', href: '/company/directory', icon: BookUser, show: !!p?.manageStaff },
    { name: 'Approvals', href: '/company/approvals', icon: CalendarCheck, badge: counts.approvals, show: !!p?.approveTrips },
    { name: 'Trips & audit', href: '/company/trips', icon: Route, show: !!p?.audit },
    { name: 'Billing & wallet', href: '/company/billing', icon: Receipt, show: !!p?.seeBilling },
    { name: 'Settings', href: '/company/settings', icon: Settings, show: !!p?.manageSettings },
  ].filter((n) => n.show);
  const close = () => setSidebarOpen(false);

  return (
    <>
      {isMobile && sidebarOpen && <div className="fixed inset-0 bg-black/60 backdrop-blur-sm z-20" onClick={close} />}
      <aside className={cn('flex flex-col z-30 transition-all duration-300 bg-[#0f1623]', isMobile ? 'fixed inset-y-0 left-0' : 'relative', sidebarOpen ? 'w-[232px]' : isMobile ? '-translate-x-full' : 'w-0 overflow-hidden')}>
        <div className="h-0.5 w-full bg-primary-500 flex-shrink-0" />
        <div className="flex items-center justify-between h-14 px-4 flex-shrink-0">
          {brand.whiteLabel && brand.logoUrl
            ? <span className="inline-flex items-center justify-center bg-white rounded-md px-2 py-1"><img src={brand.logoUrl} alt={brand.name} className="h-6 w-auto max-w-[120px] object-contain" /></span>
            : <img src={logo} alt="Runserv" className="h-7 w-auto" />}
          {isMobile && <button onClick={close} className="w-7 h-7 flex items-center justify-center rounded-lg text-white/40 hover:text-white hover:bg-white/10"><X className="h-4 w-4" /></button>}
        </div>
        <div className="mx-3 mb-2 px-3 py-2.5 rounded-xl bg-white/5 border border-white/10 flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <div className="w-8 h-8 rounded-lg bg-primary-600 flex items-center justify-center flex-shrink-0"><Building2 className="h-4 w-4 text-white" /></div>
            <div className="min-w-0"><p className="text-sm font-semibold text-white truncate leading-tight">{user?.company?.name}</p>
              <p className="text-[11px] text-white/50 mt-0.5">{user?.company ? ROLE_LABEL[user.company.memberRole] : ''}</p></div>
          </div>
        </div>
        <nav className="flex-1 overflow-y-auto px-3 pb-4">
          {nav.map((item) => (
            <NavLink key={item.href} to={item.href} end={item.end} onClick={() => isMobile && close()}
              className={({ isActive }) => cn('flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all mb-0.5 group', isActive ? 'bg-white/10 text-white' : 'text-white/60 hover:bg-white/10 hover:text-white/90')}>
              <span className="flex items-center justify-center w-8 h-8 rounded-lg flex-shrink-0 group-hover:bg-white/10"><item.icon className="h-4 w-4" /></span>
              <span className="flex-1">{item.name}</span>
              {!!item.badge && <span className="bg-amber-500 text-white text-[10px] font-bold px-1.5 py-0.5 rounded-full min-w-[18px] text-center leading-none">{item.badge > 99 ? '99+' : item.badge}</span>}
            </NavLink>))}
        </nav>
        <div className="px-3 pb-4 space-y-1 flex-shrink-0">
          {canInstall && <button onClick={install} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-primary-300 bg-primary-500/10 hover:bg-primary-500/20 transition-colors"><Download className="h-4 w-4" /> Install as app</button>}
          <button onClick={() => { logout(); navigate('/login'); }} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium text-white/50 hover:bg-white/10 hover:text-white/90 transition-colors"><LogOut className="h-4 w-4" /> Sign out</button>
          {brand.whiteLabel && <p className="text-[10px] text-white/30 text-center pt-1">Powered by Runserv</p>}
        </div>
      </aside>
    </>
  );
};
export default CompanySidebar;
