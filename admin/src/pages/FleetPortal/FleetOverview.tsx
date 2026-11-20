import React from 'react';
import { Link } from 'react-router-dom';
import { Card } from '@/components/common';
import { fleetPortalAPI } from '@/services/api/fleetPortal';
import { FleetPage, Loading, LoadError, Stat, InfoCard, money, useFleet, useLoad } from './shared';

const FleetOverview: React.FC = () => {
  const { fleet, can } = useFleet();
  const { data, error, loading, reload } = useLoad(() => fleetPortalAPI.overview(), []);
  const blocked = data?.alerts.filter((a) => a.blockers.length) ?? [];
  const expiring = data?.alerts.filter((a) => !a.blockers.length && a.warnings.length) ?? [];
  return (
    <FleetPage title={fleet?.name ?? 'Fleet overview'} subtitle="Your fleet at a glance (last 30 days for trips).">
      {loading && <Loading />}
      {error && <LoadError message={error} onRetry={reload} />}
      {data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
            <Stat label="Active vehicles" value={data.activeVehicles} />
            <Stat label="Active drivers" value={data.activeDrivers} hint="With a current vehicle assignment" />
            <Stat label="Trips in progress" value={data.tripsInProgress} />
            <Stat label="Trips completed" value={data.tripsCompleted30d} hint="Last 30 days" />
          </div>
          {can.seeFinance && data.gross30d !== undefined && (
            <div className="grid grid-cols-2 gap-4" data-testid="earnings-summary">
              <Stat label="Gross fares (30 days)" value={money(data.gross30d)} />
              <Stat label="Your net after Runserv fee (30 days)" value={money(data.net30d)} hint="Before any adjustments on a statement" />
            </div>
          )}
          <InfoCard title="Compliance alerts">
            {!data.alerts.length && <p className="text-sm text-gray-500">No vehicle has an expired, missing or soon-to-expire document. </p>}
            {blocked.length > 0 && (
              <div className="mb-4" data-testid="blocked-alerts">
                <p className="text-sm font-medium text-red-700 mb-2">Blocked from new jobs ({blocked.length})</p>
                <ul className="divide-y divide-gray-100 rounded-lg border border-red-100">
                  {blocked.map((a) => (
                    <li key={a.vehicleId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                      <Link to={`/fleet/vehicles/${a.vehicleId}`} className="font-mono font-medium text-primary-700 hover:underline">{a.registrationNumber}</Link>
                      <span className="text-red-700">{a.blockers.join('; ')}</span>
                    </li>))}
                </ul>
              </div>)}
            {expiring.length > 0 && (
              <div>
                <p className="text-sm font-medium text-amber-700 mb-2">Expiring soon ({expiring.length})</p>
                <ul className="divide-y divide-gray-100 rounded-lg border border-amber-100">
                  {expiring.map((a) => (
                    <li key={a.vehicleId} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                      <Link to={`/fleet/vehicles/${a.vehicleId}`} className="font-mono font-medium text-primary-700 hover:underline">{a.registrationNumber}</Link>
                      <span className="text-amber-700">{a.warnings.join('; ')}</span>
                    </li>))}
                </ul>
              </div>)}
          </InfoCard>
          <Card><p className="text-xs text-gray-500">A vehicle with an expired or missing mandatory document cannot take new jobs until the document is renewed and Runserv has reviewed it.</p></Card>
        </>
      )}
    </FleetPage>
  );
};
export default FleetOverview;
