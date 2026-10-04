import { Redirect } from "wouter";
import { useAuth } from "@/contexts/AuthContext";
import UserGuideView from "@/pages/UserGuideView";
import { useAgentBrandName, useAgentUserGuideEnabled } from "@/lib/agentBranding";
import { getUserGuideChapters } from "@/lib/userGuideContent";

export default function UserGuidePage() {
  const enabled = useAgentUserGuideEnabled();
  const brandName = useAgentBrandName();
  const { user } = useAuth();

  if (enabled === null) {
    return (
      <div className="flex min-h-[40vh] items-center justify-center text-sm text-muted-foreground" role="status">
        جارٍ تحميل دليل التشغيل...
      </div>
    );
  }

  if (!enabled) return <Redirect to="/" />;

  return <UserGuideView chapters={getUserGuideChapters(user)} brandName={brandName} />;
}