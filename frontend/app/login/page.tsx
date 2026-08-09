"use client";

import { Suspense, useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import Logo from "@/components/Logo";
import ParticleNetwork from "@/components/ParticleNetwork";
import CaptchaPuzzle, { CaptchaAnswer } from "@/components/CaptchaPuzzle";
import { login, verify2fa, getPublicConfig, getMe, API_URL } from "@/lib/api";

function LoginForm() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [sso, setSso] = useState<{ enabled: boolean; providerName: string } | null>(null);
  const [signupEnabled, setSignupEnabled] = useState(true);
  // Set once the password step succeeds on a 2FA-enabled account — switches
  // the form over to asking for the authenticator code instead of restarting.
  const [preAuthToken, setPreAuthToken] = useState<string | null>(null);
  const [twoFaCode, setTwoFaCode] = useState("");
  // Whether we've finished checking for an existing session. Starts false
  // so we don't flash the login form for users who turn out to already be
  // logged in (e.g. navigating straight to /login while a valid session
  // cookie/token is still present).
  const [sessionChecked, setSessionChecked] = useState(false);
  // Admin-controlled — Admin > Settings > General > CAPTCHA. Defaults
  // to off so the form isn't gated while the one-time public-config
  // fetch below is in flight.
  const [captchaEnabled, setCaptchaEnabled] = useState(false);
  const [captchaAnswer, setCaptchaAnswer] = useState<CaptchaAnswer | null>(null);
  // Puzzle now opens as a popup on submit instead of always sitting inline
  // in the form — keeps the form itself short, and only interrupts the
  // user the moment they actually try to sign in.
  const [showCaptcha, setShowCaptcha] = useState(false);
  const router = useRouter();
  const searchParams = useSearchParams();

  useEffect(() => {
    getPublicConfig()
      .then((cfg) => {
        setSso(cfg.sso);
        setSignupEnabled(cfg.signupEnabled);
        setCaptchaEnabled(cfg.captcha.enabled);
      })
      .catch(() => setSso({ enabled: false, providerName: "SSO" }));

    // Callback from /auth/sso/callback lands back here with either a
    // ready-to-use JWT or an error code in the query string.
    const token = searchParams.get("sso_token");
    const ssoError = searchParams.get("sso_error");
    if (token) {
      localStorage.setItem("visiyon_token", token);
      router.push("/");
      return;
    } else if (ssoError) {
      setError(`SSO login failed (${ssoError})`);
    } else if (searchParams.get("session_expired")) {
      setError("Your session expired — please sign in again.");
    }

    // If there's already a valid session (localStorage token or the shared
    // session cookie), skip the login form entirely and go straight to
    // /chat — previously this page rendered the form unconditionally, so a
    // logged-in user landing on /login directly (bookmark, stale link,
    // etc.) was shown "Sign in" again despite still being authenticated.
    let cancelled = false;
    getMe()
      .then(() => {
        if (!cancelled) router.replace("/");
      })
      .catch(() => {
        if (!cancelled) setSessionChecked(true);
      });
    return () => {
      cancelled = true;
    };
  }, [searchParams, router]);

  // While the session check is in flight, render nothing rather than
  // flashing the login form first for users who turn out to be logged in.
  if (!sessionChecked) return null;

  async function doLogin(answer: CaptchaAnswer | null) {
    try {
      const result = await login(email, password, answer ?? undefined);
      if (result.twoFaRequired) {
        setPreAuthToken(result.preAuthToken);
        return;
      }
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Login failed");
      // A stale/used captcha answer can't be retried — force a fresh solve.
      setCaptchaAnswer(null);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (captchaEnabled && !captchaAnswer) {
      // Ask them to solve the puzzle in a popup rather than blocking submit
      // with an inline error — the puzzle only appears when it's actually
      // needed.
      setShowCaptcha(true);
      return;
    }
    await doLogin(captchaAnswer);
  }

  async function handleVerify2fa(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    if (!preAuthToken) return;
    try {
      await verify2fa(preAuthToken, twoFaCode);
      router.push("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Invalid code");
    }
  }

  return (
    <div className="min-h-full flex">
      {/* Left panel — hidden below md, matches the reference layout where
          the artwork owns roughly half the screen on desktop. */}
      <div
        className="relative hidden md:block md:w-1/2 lg:w-[45%] bg-cover bg-center overflow-hidden"
        style={{ backgroundImage: "url(/login-bg.jpg)" }}
      >
        <ParticleNetwork />
      </div>
      <div className="flex-1 flex items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <div className="flex justify-center mb-8">
          <Logo size={24} />
        </div>
        <h1 className="text-xl font-semibold text-center mb-6">
          {preAuthToken ? "Enter your authenticator code" : "Sign in to Visiyon AI"}
        </h1>

        {!preAuthToken && sso?.enabled && (
          <>
            {/^microsoft|azure/i.test(sso.providerName) ? (
              <a
                href={`${API_URL}/auth/sso/login`}
                className="flex items-center justify-center gap-2.5 w-full text-center bg-white text-black rounded-xl py-3 text-sm font-medium hover:bg-visiyon-text/90 transition-colors mb-4"
              >
                <svg width="16" height="16" viewBox="0 0 21 21" aria-hidden="true">
                  <rect x="1" y="1" width="9" height="9" fill="#f25022" />
                  <rect x="11" y="1" width="9" height="9" fill="#7fba00" />
                  <rect x="1" y="11" width="9" height="9" fill="#00a4ef" />
                  <rect x="11" y="11" width="9" height="9" fill="#ffb900" />
                </svg>
                Continue with Microsoft
              </a>
            ) : (
              <a
                href={`${API_URL}/auth/sso/login`}
                className="block w-full text-center bg-transparent border border-visiyon-border rounded-xl py-3 text-sm font-medium hover:border-visiyon-text transition-colors mb-4"
              >
                Continue with {sso.providerName}
              </a>
            )}
            <div className="flex items-center gap-3 mb-4">
              <div className="h-px flex-1 bg-visiyon-border" />
              <span className="text-[12px] text-visiyon-text-3">or</span>
              <div className="h-px flex-1 bg-visiyon-border" />
            </div>
          </>
        )}

        {preAuthToken ? (
          <form onSubmit={handleVerify2fa} className="space-y-3">
            <input
              type="text"
              inputMode="numeric"
              autoFocus
              required
              placeholder="6-digit code or backup code"
              value={twoFaCode}
              onChange={(e) => setTwoFaCode(e.target.value)}
              className="w-full bg-transparent border border-visiyon-border rounded-xl px-4 py-3 text-sm outline-none focus:border-visiyon-text transition-colors tracking-widest"
            />
            {error && <p className="text-red-400 text-[13px] animate-blink">{error}</p>}
            <button
              type="submit"
              className="w-full bg-white text-black rounded-xl py-3 text-sm font-medium hover:bg-visiyon-text/85 transition-colors"
            >
              Verify
            </button>
            <button
              type="button"
              onClick={() => {
                setPreAuthToken(null);
                setTwoFaCode("");
                setError("");
              }}
              className="w-full text-center text-[12.5px] text-visiyon-text-2 hover:text-visiyon-text"
            >
              Back to login
            </button>
          </form>
        ) : (
          <>
            <form onSubmit={handleSubmit} className="space-y-3">
              <input
                type="email"
                required
                placeholder="Email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full bg-transparent border border-visiyon-border rounded-xl px-4 py-3 text-sm outline-none focus:border-visiyon-text transition-colors"
              />
              <input
                type="password"
                required
                placeholder="Password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                className="w-full bg-transparent border border-visiyon-border rounded-xl px-4 py-3 text-sm outline-none focus:border-visiyon-text transition-colors"
              />
              {error && <p className="text-red-400 text-[13px] animate-blink">{error}</p>}
              <div className="flex justify-end">
                <Link href="/forgot-password" className="text-[12.5px] text-visiyon-text-2 hover:text-visiyon-text underline">
                  Forgot password?
                </Link>
              </div>
              <button
                type="submit"
                className="w-full bg-white text-black rounded-xl py-3 text-sm font-medium hover:bg-visiyon-text/85 transition-colors disabled:opacity-40 disabled:hover:bg-white"
              >
                Sign in
              </button>
            </form>
            {captchaEnabled && showCaptcha && (
              <div
                className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
                onClick={() => setShowCaptcha(false)}
              >
                <div
                  className="bg-visiyon-bg border border-visiyon-border rounded-xl p-5 w-full max-w-[360px]"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="flex items-center justify-between mb-3">
                    <p className="text-[13.5px] font-medium">Confirm you're human</p>
                    <button
                      type="button"
                      onClick={() => setShowCaptcha(false)}
                      className="text-visiyon-text-3 hover:text-visiyon-text text-[13px]"
                      title="Cancel"
                    >
                      ✕
                    </button>
                  </div>
                  <CaptchaPuzzle
                    onSolved={(answer) => {
                      setCaptchaAnswer(answer);
                      setShowCaptcha(false);
                      // Solving the puzzle IS the "try again" action here —
                      // continue straight into the login attempt instead of
                      // making them hit "Sign in" a second time.
                      doLogin(answer);
                    }}
                    onReset={() => setCaptchaAnswer(null)}
                  />
                </div>
              </div>
            )}
            {signupEnabled && (
              <p className="text-center text-[13.5px] text-visiyon-text-2 mt-6">
                No account?{" "}
                <Link href="/register" className="text-visiyon-text underline">
                  Sign up
                </Link>
              </p>
            )}
          </>
        )}
      </div>
      </div>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={null}>
      <LoginForm />
    </Suspense>
  );
}
