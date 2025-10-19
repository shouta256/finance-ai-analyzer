"use client";

import { Suspense } from "react";
import dynamic from "next/dynamic";

const CallbackClient = dynamic(() => import("./callback-client"), { ssr: false });

export default function AuthCallbackPage() {
  return (
    <Suspense fallback={<LoadingView />}> 
      <CallbackClient />
    </Suspense>
  );
}

function LoadingView() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-slate-50 px-6 text-center">
      <div className="w-full max-w-md rounded-2xl bg-white p-10 shadow-lg">
        <h1 className="text-xl font-semibold text-slate-800">Connecting to Safepocket</h1>
        <p className="mt-3 text-sm text-slate-600">Authorizing...</p>
      </div>
    </main>
  );
}
