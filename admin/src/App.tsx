// admin-web/src/App.tsx
import React from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { useAuthStore } from '@/store/authStore';
import Layout from '@/components/layout/Layout';

import Login              from '@/pages/Auth/Login';
import Dashboard          from '@/pages/Dashboard/Dashboard';
import UserList           from '@/pages/Users/UserList';
import UserDetails        from '@/pages/Users/UserDetails';
import CreateAdminUser    from '@/pages/Users/CreateAdminUser';
import AdminUsers         from '@/pages/Settings/AdminUsers';
import DriverList         from '@/pages/Drivers/DriverList';
import DriverApproval     from '@/pages/Drivers/DriverApproval';
import DriverDetails      from '@/pages/Drivers/DriverDetails';
import DriverDocuments    from '@/pages/Drivers/DriverDocuments';
import PartnerList        from '@/pages/Partners/PartnerList';
import PartnerApproval    from '@/pages/Partners/PartnerApproval';
import PartnerDetails     from '@/pages/Partners/PartnerDetails';
import IncompleteApplications from '@/pages/Applications/IncompleteApplications';
import RideList           from '@/pages/Rides/RideList';
import RideDetails        from '@/pages/Rides/RideDetails';
import LiveRides          from '@/pages/Rides/LiveRides';
import DeliveryList       from '@/pages/Deliveries/DeliveryList';
import GuestBookingQueue  from '@/pages/GuestBookings/GuestBookingQueue';
import GuestBookingLookup from '@/pages/GuestBookings/GuestBookingLookup';
import GuestAbuse         from '@/pages/GuestBookings/GuestAbuse';
import GuestSms           from '@/pages/GuestBookings/GuestSms';
import GuestEmail         from '@/pages/GuestBookings/GuestEmail';
import GuestAttention      from '@/pages/GuestBookings/GuestAttention';
import GuestMetrics        from '@/pages/GuestBookings/GuestMetrics';
import GuestBookingDetail from '@/pages/GuestBookings/GuestBookingDetail';
import DeliveryDetails    from '@/pages/Deliveries/DeliveryDetails';
import TicketList         from '@/pages/Support/TicketList';
import TicketDetail       from '@/pages/Support/TicketDetail';
import PaymentList        from '@/pages/Payments/PaymentList';
import PaymentProviders   from '@/pages/PaymentProviders/PaymentProviders';
import Analytics          from '@/pages/Analytics/Overview';
import GeneralSettings    from '@/pages/Settings/GeneralSettings';
import MapSettings        from '@/pages/Settings/MapSettings';
import CountryList        from '@/pages/Countries/CountryList';
import CountrySettings    from '@/pages/Countries/CountrySettings';
import NotificationsPage  from '@/pages/Notifications/NotificationsPage';
import PayoutManagement   from '@/pages/Wallets/PayoutManagement';
import AppFeedbackList from '@/pages/Feedback/AppFeedbackList';
import LiveDeliveries from '@/pages/Deliveries/LiveDeliveries';

// Feature-flagged page imports — only used when flags are enabled
import CompanyList        from '@/pages/Corporate/CompanyList';
import CompanyDetails     from '@/pages/Corporate/CompanyDetails';
import OrgInvoices        from '@/pages/Corporate/Invoices';
import OrgPayouts         from '@/pages/Corporate/OrgPayouts';
import CompanyDashboard   from '@/pages/Company/CompanyDashboard';
import CompanyStaff       from '@/pages/Company/StaffPage';
import CompanyStaffAudit  from '@/pages/Company/StaffAudit';
import CompanyTrips       from '@/pages/Company/TripsPage';
import CompanyApprovals    from '@/pages/Company/ApprovalsPage';
import CompanyDepartments  from '@/pages/Company/DepartmentsPage';
import CompanyDirectory    from '@/pages/Company/DirectoryPage';
import CompanyBilling     from '@/pages/Company/BillingPage';
import CompanySettings    from '@/pages/Company/SettingsPage';
import FleetList          from '@/pages/Fleets/FleetList';
import FleetDetails       from '@/pages/Fleets/FleetDetails';
import VehicleList        from '@/pages/Fleets/VehicleList';
import FleetSettlements   from '@/pages/Fleets/FleetSettlements';
import FleetTripReconciliation from '@/pages/Fleets/TripReconciliation';
import BankList           from '@/pages/Banks/BankList';
import CampaignList       from '@/pages/Banks/CampaignList';
import CampaignDetails    from '@/pages/Banks/CampaignDetails';
import BankSettlements    from '@/pages/Banks/BankSettlements';
import BankReceipts       from '@/pages/Banks/BankReceipts';
import Approvals          from '@/pages/Banks/Approvals';
import Reconciliation     from '@/pages/Finance/Reconciliation';
import OpsAlerts          from '@/pages/Alerts/OpsAlerts';
import AuditLog           from '@/pages/Audit/AuditLog';
import StatementImport    from '@/pages/Banks/StatementImport';
import DemoRequests       from '@/pages/Settings/DemoRequests';
import FleetOverview      from '@/pages/FleetPortal/FleetOverview';
import FleetVehicles      from '@/pages/FleetPortal/FleetVehicles';
import FleetVehicleDetail from '@/pages/FleetPortal/FleetVehicleDetail';
import FleetDrivers       from '@/pages/FleetPortal/FleetDrivers';
import FleetTrips         from '@/pages/FleetPortal/FleetTrips';
import FleetSettlementsPage from '@/pages/FleetPortal/FleetSettlementsPage';
import FleetTeam          from '@/pages/FleetPortal/FleetTeam';
import FleetShifts        from '@/pages/FleetPortal/FleetShifts';
import AcceptInvite       from '@/pages/FleetPortal/AcceptInvite';
import FleetSettings      from '@/pages/FleetPortal/FleetSettings';
import FleetApply         from '@/pages/FleetPortal/FleetApply';
import PrivacyPolicy      from '@/pages/Legal/PrivacyPolicy';
import AccountDeletion    from '@/pages/Legal/AccountDeletion'; 

// ─── Feature flags (set in admin-web/.env) ────────────────────────────────────
const ENABLE_CORPORATE = import.meta.env.VITE_ENABLE_CORPORATE !== 'false'; // core product — on unless explicitly disabled
const ENABLE_FLEET      = import.meta.env.VITE_ENABLE_FLEET !== 'false';      // staged activation: mirrors backend ENABLE_FLEET
const ENABLE_BANK_OFFERS = import.meta.env.VITE_ENABLE_BANK_OFFERS !== 'false'; // mirrors backend ENABLE_BANK_OFFERS

const ProtectedRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, user } = useAuthStore();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  // Company representatives and fleet users only see their own portal.
  if (user?.company || user?.fleet) return <Navigate to="/" replace />;
  return <Layout>{children}</Layout>;
};

/** Pages that exist for both Runserv staff and company reps (e.g. notifications). */
const AnyUserRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated } = useAuthStore();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <Layout>{children}</Layout>;
};

const CompanyRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, user } = useAuthStore();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!user?.company) return <Navigate to="/" replace />;
  return <Layout>{children}</Layout>;
};

/** Fleet Partner Portal: people who belong to a fleet account (the API scopes every request to their own fleet). */
const FleetRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, user } = useAuthStore();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (!user?.fleet) return <Navigate to="/" replace />;
  return <Layout>{children}</Layout>;
};

/** "/" is the company overview for a company rep, the fleet overview for fleet staff, the admin dashboard for Runserv staff. */
const HomeRoute: React.FC = () => {
  const { isAuthenticated, user } = useAuthStore();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  return <Layout>{user?.company ? <CompanyDashboard /> : user?.fleet ? <FleetOverview /> : <Dashboard />}</Layout>;
};

/** Fleet / bank administration: Runserv admins who are not limited to specific countries (the API enforces the same). */
const PartnershipsRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { isAuthenticated, user } = useAuthStore();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  if (user?.company || user?.fleet) return <Navigate to="/" replace />;
  const staff = user?.role === 'ADMIN' || user?.role === 'SUPER_ADMIN';
  const limited = user?.role !== 'SUPER_ADMIN' && (user?.supportCountries?.length ?? 0) > 0;
  if (!staff || limited) return <Navigate to="/" replace />;
  return <Layout>{children}</Layout>;
};

const SuperAdminRoute: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { user, isAuthenticated } = useAuthStore();
  if (!isAuthenticated) return <Navigate to="/login" replace />;
  // Super Admin, or a country admin (an ADMIN assigned to specific countries).
  const countryAdmin = user?.role === 'ADMIN' && (user?.supportCountries?.length ?? 0) > 0;
  if (user?.role !== 'SUPER_ADMIN' && !countryAdmin) return <Navigate to="/" replace />;
  return <Layout>{children}</Layout>;
};

function App() {
  const { isAuthenticated } = useAuthStore();
  return (
    <>
      <Router>
        <Routes>
          <Route path="/login" element={!isAuthenticated ? <Login /> : <Navigate to="/" replace />} />
          <Route path="/" element={<HomeRoute />} />

          {/* Company portal (company representatives) */}
          <Route path="/company/staff"        element={<CompanyRoute><CompanyStaff /></CompanyRoute>} />
          <Route path="/company/staff/:id"    element={<CompanyRoute><CompanyStaffAudit /></CompanyRoute>} />
          <Route path="/company/trips"         element={<CompanyRoute><CompanyTrips /></CompanyRoute>} />
          <Route path="/company/approvals"     element={<CompanyRoute><CompanyApprovals /></CompanyRoute>} />
          <Route path="/company/weekend"       element={<Navigate to="/company/approvals" replace />} />
          <Route path="/company/departments"   element={<CompanyRoute><CompanyDepartments /></CompanyRoute>} />
          <Route path="/company/directory"     element={<CompanyRoute><CompanyDirectory /></CompanyRoute>} />
          <Route path="/company/billing"       element={<CompanyRoute><CompanyBilling /></CompanyRoute>} />
          <Route path="/company/settings"      element={<CompanyRoute><CompanySettings /></CompanyRoute>} />

          {/* Fleet Partner Portal (fleet staff). Public application page first. */}
          {ENABLE_FLEET && (
            <>
              <Route path="/fleet/apply"        element={!isAuthenticated ? <FleetApply /> : <Navigate to="/" replace />} />
              <Route path="/fleet/vehicles"     element={<FleetRoute><FleetVehicles /></FleetRoute>} />
              <Route path="/fleet/vehicles/:id" element={<FleetRoute><FleetVehicleDetail /></FleetRoute>} />
              <Route path="/fleet/drivers"      element={<FleetRoute><FleetDrivers /></FleetRoute>} />
              <Route path="/fleet/trips"        element={<FleetRoute><FleetTrips /></FleetRoute>} />
              <Route path="/fleet/settlements"  element={<FleetRoute><FleetSettlementsPage /></FleetRoute>} />
              <Route path="/fleet/team"         element={<FleetRoute><FleetTeam /></FleetRoute>} />
              <Route path="/fleet/shifts"       element={<FleetRoute><FleetShifts /></FleetRoute>} />
              <Route path="/fleet/accept-invite" element={<AcceptInvite />} />
              <Route path="/fleet/settings"     element={<FleetRoute><FleetSettings /></FleetRoute>} />
            </>
          )}

          {/* Notifications */}
          <Route path="/notifications" element={<AnyUserRoute><NotificationsPage /></AnyUserRoute>} />

          {/* Users */}
          <Route path="/users"              element={<ProtectedRoute><UserList /></ProtectedRoute>} />
          <Route path="/users/create-admin" element={<SuperAdminRoute><CreateAdminUser /></SuperAdminRoute>} />
          {/* Staff & country assignments: Super Admin, or a country admin for their own countries. */}
          <Route path="/staff" element={<SuperAdminRoute><AdminUsers /></SuperAdminRoute>} />
          <Route path="/users/:id"          element={<ProtectedRoute><UserDetails /></ProtectedRoute>} />

          {/* Incomplete Applications */}
          <Route path="/applications/incomplete" element={<ProtectedRoute><IncompleteApplications /></ProtectedRoute>} />

          {/* Drivers — statics before :id wildcard */}
          <Route path="/drivers"               element={<ProtectedRoute><DriverList /></ProtectedRoute>} />
          <Route path="/drivers/pending"        element={<ProtectedRoute><DriverApproval /></ProtectedRoute>} />
          <Route path="/drivers/:id/documents" element={<ProtectedRoute><DriverDocuments /></ProtectedRoute>} />
          <Route path="/drivers/:id"           element={<ProtectedRoute><DriverDetails /></ProtectedRoute>} />

          {/* Partners */}
          <Route path="/partners"         element={<ProtectedRoute><PartnerList /></ProtectedRoute>} />
          <Route path="/partners/pending" element={<ProtectedRoute><PartnerApproval /></ProtectedRoute>} />
          <Route path="/partners/:id"     element={<ProtectedRoute><PartnerDetails /></ProtectedRoute>} />

          {/* Rides — /live before /:id */}
          <Route path="/rides"      element={<ProtectedRoute><RideList /></ProtectedRoute>} />
          <Route path="/rides/live" element={<ProtectedRoute><LiveRides /></ProtectedRoute>} />
          <Route path="/rides/:id"  element={<ProtectedRoute><RideDetails /></ProtectedRoute>} />

          {/* Deliveries */}
          <Route path="/deliveries"      element={<ProtectedRoute><DeliveryList /></ProtectedRoute>} />
          <Route path="/deliveries/live" element={<ProtectedRoute><LiveDeliveries /></ProtectedRoute>} />
          <Route path="/deliveries/:id"  element={<ProtectedRoute><DeliveryDetails /></ProtectedRoute>} />
          {/* M16 guest bookings (backend enforces market guard + scope; the UI hides nothing it relies on) */}
          <Route path="/guest-bookings"         element={<ProtectedRoute><GuestBookingQueue /></ProtectedRoute>} />
          <Route path="/guest-bookings/lookup"  element={<ProtectedRoute><GuestBookingLookup /></ProtectedRoute>} />
          <Route path="/guest-bookings/sms"     element={<ProtectedRoute><GuestSms /></ProtectedRoute>} />
          <Route path="/guest-bookings/email"   element={<ProtectedRoute><GuestEmail /></ProtectedRoute>} />
          <Route path="/guest-bookings/attention" element={<ProtectedRoute><GuestAttention /></ProtectedRoute>} />
          <Route path="/guest-bookings/metrics"  element={<ProtectedRoute><GuestMetrics /></ProtectedRoute>} />
          <Route path="/guest-bookings/abuse"   element={<ProtectedRoute><GuestAbuse /></ProtectedRoute>} />
          <Route path="/guest-bookings/:id"     element={<ProtectedRoute><GuestBookingDetail /></ProtectedRoute>} />

          {/* Countries — config is SUPER_ADMIN-only server-side, but ADMINs
              can view the per-market operations queues, so this is a normal
              protected route rather than a SuperAdminRoute. */}
          <Route path="/countries" element={<ProtectedRoute><CountryList /></ProtectedRoute>} />
          {/* Per-country pricing, commission, wallet, payout & bonus rules.
              Everyone with settings access can view; only SUPER_ADMIN can save
              (enforced server-side). */}
          <Route path="/country-settings"       element={<ProtectedRoute><CountrySettings /></ProtectedRoute>} />
          <Route path="/country-settings/:code" element={<ProtectedRoute><CountrySettings /></ProtectedRoute>} />

          {/* Wallet management */}
          <Route path="/payment-providers" element={<ProtectedRoute><PaymentProviders /></ProtectedRoute>} />
          <Route path="/wallets" element={<ProtectedRoute><PayoutManagement /></ProtectedRoute>} />

          {/* Feedback */}
          <Route path="/feedback" element={<ProtectedRoute><AppFeedbackList /></ProtectedRoute>} />

          {/* Support */}
          <Route path="/support/tickets"     element={<ProtectedRoute><TicketList /></ProtectedRoute>} />
          <Route path="/support/tickets/:id" element={<ProtectedRoute><TicketDetail /></ProtectedRoute>} />

          {/* ─── Feature-flagged routes ─────────────────────────────────────── */}

          {/* Corporate */}
          {ENABLE_CORPORATE && (
            <>
              <Route path="/corporate"       element={<ProtectedRoute><CompanyList /></ProtectedRoute>} />
              <Route path="/corporate/trips" element={<ProtectedRoute><CompanyList /></ProtectedRoute>} />
              <Route path="/corporate/invoices" element={<ProtectedRoute><OrgInvoices /></ProtectedRoute>} />
              <Route path="/corporate/payouts"  element={<ProtectedRoute><OrgPayouts /></ProtectedRoute>} />
              <Route path="/corporate/:id"   element={<ProtectedRoute><CompanyDetails /></ProtectedRoute>} />
            </>
          )}

          {/* Fleet partners — statics before :id */}
          {ENABLE_FLEET && (
            <>
              <Route path="/fleets"             element={<PartnershipsRoute><FleetList /></PartnershipsRoute>} />
              <Route path="/fleets/vehicles"    element={<PartnershipsRoute><VehicleList /></PartnershipsRoute>} />
              <Route path="/fleets/settlements" element={<PartnershipsRoute><FleetSettlements /></PartnershipsRoute>} />
              <Route path="/fleets/reconciliation" element={<PartnershipsRoute><FleetTripReconciliation /></PartnershipsRoute>} />
              <Route path="/fleets/:id"         element={<PartnershipsRoute><FleetDetails /></PartnershipsRoute>} />
            </>
          )}

          {/* Bank offers — statics before :id */}
          {ENABLE_BANK_OFFERS && (
            <>
              <Route path="/banks"                element={<PartnershipsRoute><BankList /></PartnershipsRoute>} />
              <Route path="/banks/campaigns"      element={<PartnershipsRoute><CampaignList /></PartnershipsRoute>} />
              <Route path="/banks/campaigns/:id"  element={<PartnershipsRoute><CampaignDetails /></PartnershipsRoute>} />
              <Route path="/banks/settlements"    element={<PartnershipsRoute><BankSettlements /></PartnershipsRoute>} />
              <Route path="/banks/receipts"       element={<PartnershipsRoute><BankReceipts /></PartnershipsRoute>} />
              <Route path="/banks/import"         element={<PartnershipsRoute><StatementImport /></PartnershipsRoute>} />
            </>
          )}

          {/* Other */}
          <Route path="/payments"  element={<ProtectedRoute><PaymentList /></ProtectedRoute>} />
          <Route path="/analytics" element={<ProtectedRoute><Analytics /></ProtectedRoute>} />
          <Route path="/settings"  element={<ProtectedRoute><GeneralSettings /></ProtectedRoute>} />
          <Route path="/settings/maps" element={<ProtectedRoute><MapSettings /></ProtectedRoute>} />
          <Route path="/approvals" element={<PartnershipsRoute><Approvals /></PartnershipsRoute>} />
          <Route path="/reconciliation" element={<PartnershipsRoute><Reconciliation /></PartnershipsRoute>} />
          <Route path="/audit-log" element={<PartnershipsRoute><AuditLog /></PartnershipsRoute>} />
          <Route path="/ops-alerts" element={<PartnershipsRoute><OpsAlerts /></PartnershipsRoute>} />
          <Route path="/demo-requests" element={<PartnershipsRoute><DemoRequests /></PartnershipsRoute>} />

          {/* Legal — public, no auth required */}
          <Route path="/privacy" element={<PrivacyPolicy />} />
          <Route path="/delete-account" element={<AccountDeletion />} />   
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>

      <Toaster
        position="top-right"
        toastOptions={{
          duration: 4000,
          style: { background: '#fff', color: '#363636' },
          success: { duration: 3000, iconTheme: { primary: '#34C759', secondary: '#fff' } },
          error:   { duration: 4000, iconTheme: { primary: '#FF3B30', secondary: '#fff' } },
        }}
      />
    </>
  );
}

export default App;