import { Loader2 } from "lucide-react";
import { Link } from "wouter";
import { Button } from "@/components/ui/button";

export default function NotFound() {
  return (
    <div className="min-h-screen w-full flex items-center justify-center bg-background">
      <div className="text-center space-y-6 px-4">
        <h1 className="text-8xl font-bold text-primary opacity-20">404</h1>
        <h2 className="text-2xl font-bold text-foreground">
          الصفحة غير موجودة
        </h2>
        <p className="text-muted-foreground max-w-md mx-auto">
          عذراً، الصفحة التي تبحث عنها غير موجودة أو تم نقلها.
        </p>
        <Link href="/">
          <Button className="mt-4 gap-2 rounded-full h-12 px-8">
            العودة للرئيسية
          </Button>
        </Link>
      </div>
    </div>
  );
}
