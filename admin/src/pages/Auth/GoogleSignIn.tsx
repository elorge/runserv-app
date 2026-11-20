// "Sign in with Google" (Google Identity Services). Renders nothing unless VITE_GOOGLE_CLIENT_ID is set.
import React, { useEffect, useRef } from 'react';

const CLIENT_ID = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
declare global { interface Window { google?: any } }

const GoogleSignIn: React.FC<{ onCredential: (idToken: string) => void }> = ({ onCredential }) => {
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!CLIENT_ID) return;
    const init = () => {
      if (!window.google || !box.current) return;
      window.google.accounts.id.initialize({ client_id: CLIENT_ID, callback: (r: { credential: string }) => onCredential(r.credential) });
      window.google.accounts.id.renderButton(box.current, { theme: 'outline', size: 'large', width: 320, text: 'continue_with' });
    };
    if (window.google) { init(); return; }
    const s = document.createElement('script');
    s.src = 'https://accounts.google.com/gsi/client'; s.async = true; s.defer = true; s.onload = init;
    document.head.appendChild(s);
  }, [onCredential]);

  if (!CLIENT_ID) return null;
  return (
    <div className="mt-5">
      <div className="flex items-center gap-3 text-xs text-gray-400"><span className="flex-1 h-px bg-gray-200" />or<span className="flex-1 h-px bg-gray-200" /></div>
      <div ref={box} className="mt-4 flex justify-center" />
    </div>
  );
};
export default GoogleSignIn;
