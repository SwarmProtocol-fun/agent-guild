import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ArrowRight } from "lucide-react";

export default function NotFound() {
  return (
    <div className="flex min-h-screen flex-col items-center justify-center gap-6 bg-background px-6 text-center">
      <p className="text-sm font-medium tracking-widest text-muted-foreground">404</p>
      <h1 className="text-3xl font-semibold text-foreground">Page not found</h1>
      <p className="max-w-sm text-muted-foreground">
        The page you&apos;re looking for doesn&apos;t exist or has moved.
      </p>
      <Link href="/">
        <Button size="lg" className="h-12 px-8 rounded-full bg-gradient-to-r from-amber-500 to-orange-600 hover:from-amber-600 hover:to-orange-700 text-black font-semibold group">
          Back home
          <ArrowRight className="ml-2 w-4 h-4 transition-transform group-hover:translate-x-1" />
        </Button>
      </Link>
    </div>
  );
}
