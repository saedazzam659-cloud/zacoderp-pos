import { useState } from "react";
import { useLogin } from "@/hooks/use-auth";
import { Building2, KeyRound, UserRound, ArrowRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export default function Login() {
  const login = useLogin();
  const [formData, setFormData] = useState({
    companyCode: "",
    username: "",
    password: "",
  });

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    login.mutate(formData);
  };

  return (
    <div className="min-h-[100dvh] flex flex-col justify-center items-center p-4 bg-muted/30 relative overflow-hidden">
      {/* Background decoration */}
      <div className="absolute top-[-10%] start-[-10%] w-96 h-96 bg-primary/10 rounded-full blur-3xl pointer-events-none" />
      <div className="absolute bottom-[-10%] end-[-10%] w-96 h-96 bg-primary/5 rounded-full blur-3xl pointer-events-none" />
      
      <div className="w-full max-w-md bg-card p-8 rounded-3xl shadow-xl shadow-black/5 border relative z-10">
        <div className="flex flex-col items-center text-center mb-8">
          <div className="w-16 h-16 bg-primary/10 text-primary rounded-2xl flex items-center justify-center mb-4 shadow-inner">
            <Building2 className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold tracking-tight mb-2">ZacodeHR</h1>
          <p className="text-sm text-muted-foreground">بوابة الخدمة الذاتية للموظفين</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor="companyCode">رمز الشركة</Label>
            <div className="relative">
              <Building2 className="w-5 h-5 absolute start-3 top-2.5 text-muted-foreground" />
              <Input
                id="companyCode"
                placeholder="مثال: ZAC"
                className="ps-10 h-11 bg-muted/50 border-border/50 focus:bg-background transition-colors"
                value={formData.companyCode}
                onChange={(e) => setFormData({ ...formData, companyCode: e.target.value })}
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="username">رقم الموظف أو اسم المستخدم</Label>
            <div className="relative">
              <UserRound className="w-5 h-5 absolute start-3 top-2.5 text-muted-foreground" />
              <Input
                id="username"
                placeholder="رقم الموظف"
                className="ps-10 h-11 bg-muted/50 border-border/50 focus:bg-background transition-colors"
                value={formData.username}
                onChange={(e) => setFormData({ ...formData, username: e.target.value })}
                required
              />
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="password">كلمة المرور</Label>
            <div className="relative">
              <KeyRound className="w-5 h-5 absolute start-3 top-2.5 text-muted-foreground" />
              <Input
                id="password"
                type="password"
                placeholder="••••••••"
                className="ps-10 h-11 bg-muted/50 border-border/50 focus:bg-background transition-colors text-left dir-ltr"
                value={formData.password}
                onChange={(e) => setFormData({ ...formData, password: e.target.value })}
                required
              />
            </div>
          </div>

          <Button 
            type="submit" 
            className="w-full h-11 text-base font-bold shadow-lg shadow-primary/25 rounded-xl mt-4 gap-2"
            disabled={login.isPending}
          >
            {login.isPending ? "جاري الدخول..." : "تسجيل الدخول"}
            <ArrowRight className="w-5 h-5 rotate-180" />
          </Button>
        </form>
      </div>
    </div>
  );
}
