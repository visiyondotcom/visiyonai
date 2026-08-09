import Link from "next/link";
import Logo from "./Logo";

export default function Navbar() {
  return (
    <header className="fixed top-0 left-0 right-0 z-50 bg-visiyon-bg border-b border-visiyon-border">
      <nav className="max-w-6xl mx-auto h-16 px-6 flex items-center justify-between">
        <Link href="/">
          <Logo />
        </Link>
        <div className="hidden md:flex items-center gap-8 text-sm text-visiyon-text-2">
          <a href="#models" className="hover:text-visiyon-text transition-colors">Models</a>
          <a href="#features" className="hover:text-visiyon-text transition-colors">Features</a>
          <a href="#faq" className="hover:text-visiyon-text transition-colors">FAQ</a>
          <a href="#contact" className="hover:text-visiyon-text transition-colors">Contact</a>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/login" className="text-sm text-visiyon-text-2 hover:text-visiyon-text transition-colors">
            Log in
          </Link>
          <Link
            href="/"
            className="inline-flex items-center justify-center text-sm font-medium px-4 py-2 rounded-full bg-white text-black hover:bg-transparent hover:text-visiyon-text border border-visiyon-text transition-colors"
          >
            Start chatting
          </Link>
        </div>
      </nav>
    </header>
  );
}
