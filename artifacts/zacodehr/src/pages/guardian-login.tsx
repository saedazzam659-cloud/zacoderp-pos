import { useState, type FormEvent } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeft, ArrowRight, Eye, EyeOff, Fingerprint, KeyRound, LockKeyhole, School, ShieldCheck, UserRound } from "lucide-react";
import { useGuardianPortalLogin } from "@workspace/api-client-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setGuardianSession } from "@/lib/guardianAuth";

export default function GuardianLogin() {
  const [, setLocation] = useLocation();
  const login = useGuardianPortalLogin();
  const [formData, setFormData] = useState({ companyCode: "", username: "", password: "" });
  const [showPassword, setShowPassword] = useState(false);
  const [validation, setValidation] = useState("");

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setValidation("");
    const values = {
      companyCode: formData.companyCode.trim(),
      username: formData.username.trim(),
      password: formData.password,
    };
    if (!values.companyCode || !values.username || !values.password) {
      setValidation("يرجى إدخال رمز المدرسة واسم المستخدم وكلمة المرور.");
      return;
    }
    login.mutate({ data: values }, {
      onSuccess: (result) => {
        setGuardianSession(result.token, result.account);
        setLocation("/guardian");
      },
    });
  };

  const errorMessage = login.error instanceof Error ? login.error.message : "تعذر تسجيل الدخول. تحقق من بياناتك وحاول مرة أخرى.";

  return (
    <main dir="rtl" className="guardian-login min-h-[100dvh]">
      <div className="guardian-login-top">
        <Link href="/login" className="guardian-back" data-testid="link-employee-login">
          <ArrowRight size={16} /> بوابة الموظفين
        </Link>
        <div className="guardian-brand">
          <span className="brand-mark"><School size={21} /></span>
          <span><strong>ZacodeHR</strong><small>بوابة الأسرة</small></span>
        </div>
      </div>
      <div className="guardian-login-grid">
        <section className="login-story">
          <div className="story-kicker"><span /> مساحة آمنة لعائلتك</div>
          <h1>كل ما يخص<br /><em>رحلة طفلك</em><br />في مكان واحد.</h1>
          <p>تابع الحضور والنتائج والرسوم، وابقَ على اطلاع دائم بموافقة الحضور بالوجه — بكل وضوح وخصوصية.</p>
          <div className="story-note">
            <span className="note-icon"><ShieldCheck size={19} /></span>
            <span><b>حساب مستقل للعائلة</b><small>بيانات دخولك منفصلة عن بوابة الموظفين.</small></span>
          </div>
          <div className="story-orbit orbit-one" /><div className="story-orbit orbit-two" />
          <span className="story-index">01 / FAMILY PORTAL</span>
        </section>
        <section className="guardian-login-card" aria-labelledby="guardian-login-title">
          <div className="card-eyebrow"><span className="eyebrow-line" /> دخول ولي الأمر</div>
          <h2 id="guardian-login-title">مرحباً بعودتك</h2>
          <p className="login-subtitle">سجّل الدخول لمتابعة أبنائك.</p>
          <form onSubmit={handleSubmit} className="guardian-form" noValidate>
            <div className="field-group">
              <Label htmlFor="guardian-company">رمز المدرسة</Label>
              <div className="input-wrap">
                <School size={18} />
                <Input id="guardian-company" autoComplete="organization" placeholder="أدخل رمز المدرسة" value={formData.companyCode} onChange={(e) => setFormData({ ...formData, companyCode: e.target.value })} data-testid="input-company-code" aria-invalid={!!validation && !formData.companyCode.trim()} />
              </div>
            </div>
            <div className="field-group">
              <Label htmlFor="guardian-username">اسم المستخدم</Label>
              <div className="input-wrap">
                <UserRound size={18} />
                <Input id="guardian-username" autoComplete="username" placeholder="اسم المستخدم المسجل" value={formData.username} onChange={(e) => setFormData({ ...formData, username: e.target.value })} data-testid="input-guardian-username" aria-invalid={!!validation && !formData.username.trim()} />
              </div>
            </div>
            <div className="field-group">
              <Label htmlFor="guardian-password">كلمة المرور</Label>
              <div className="input-wrap password-wrap">
                <KeyRound size={18} />
                <Input id="guardian-password" type={showPassword ? "text" : "password"} autoComplete="current-password" placeholder="أدخل كلمة المرور" value={formData.password} onChange={(e) => setFormData({ ...formData, password: e.target.value })} data-testid="input-guardian-password" />
                <button type="button" className="password-toggle" aria-label={showPassword ? "إخفاء كلمة المرور" : "إظهار كلمة المرور"} onClick={() => setShowPassword((value) => !value)} data-testid="button-toggle-password">
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
            </div>
            {validation && <p className="form-alert" role="alert" data-testid="text-login-validation">{validation}</p>}
            {login.isError && <p className="form-alert" role="alert" data-testid="text-login-error">{errorMessage}</p>}
            <Button type="submit" disabled={login.isPending} className="guardian-submit" data-testid="button-guardian-login">
              {login.isPending ? <><span className="button-shimmer" /> جارٍ التحقق من بياناتك</> : <>دخول إلى حسابي <ArrowLeft size={18} /></>}
            </Button>
          </form>
          <div className="login-trust"><LockKeyhole size={14} /> اتصال خاص وآمن بحساب ولي الأمر</div>
          <div className="guardian-help">هل تحتاج مساعدة في الدخول؟ <span>تواصل مع إدارة المدرسة</span></div>
        </section>
      </div>
      <footer className="guardian-login-footer"><span>© ZacodeHR</span><span>بوابة الأسرة · متابعة مطمئنة</span><span><Fingerprint size={15} /> الخصوصية أولاً</span></footer>
    </main>
  );
}
