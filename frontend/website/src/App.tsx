import { useState, useEffect, lazy, Suspense, Component, type ErrorInfo, type ReactNode } from 'react';

function lazyWithRetry<T extends React.ComponentType<any>>(
    factory: () => Promise<{ default: T } | any>
) {
    return lazy(async () => {
        const pageHasBeenForceRefreshed = sessionStorage.getItem('dhaaga_chunk_retry_active');
        try {
            const module = await factory();
            sessionStorage.removeItem('dhaaga_chunk_retry_active');
            return 'default' in module ? module : { default: module };
        } catch (error: any) {
            console.warn('Vite dynamic chunk load error:', error);
            if (!pageHasBeenForceRefreshed) {
                sessionStorage.setItem('dhaaga_chunk_retry_active', 'true');
                window.location.reload();
                return new Promise<{ default: T }>(() => {});
            }
            sessionStorage.removeItem('dhaaga_chunk_retry_active');
            throw error;
        }
    });
}

const confirmCbcNavigation = () => true;

const StaffPortal = lazyWithRetry(() => import("@/components/StaffPortal").then(module => ({ default: module.StaffPortal })));
const SuperAdminDashboard = lazyWithRetry(() => import("@/components/SuperAdminDashboard").then(module => ({ default: module.SuperAdminDashboard })));
const HospitalDashboard = lazyWithRetry(() => import("@/components/HospitalDashboard").then(module => ({ default: module.HospitalDashboard })));
const ClinicAdminDashboard = lazyWithRetry(() => import("@/components/ClinicAdminDashboard").then(module => ({ default: module.ClinicAdminDashboard })));
import { AppLayout } from "@/components/layout/AppLayout";
import { WebsiteLanguageSelect, WebsiteLocalizationRuntime } from "@/components/WebsiteLanguageSelect";
const AdminSetup = lazyWithRetry(() => import("@/components/AdminSetup").then(module => ({ default: module.AdminSetup })));
import { HospitalProvider, useHospital } from '@/context/HospitalContext';
import { TourProvider } from '@/context/TourContext';
import { ProductTour } from '@/components/ProductTour';
import { ResetPasswordPage } from "@/components/ResetPasswordPage";
const HospitalsRegistry = lazyWithRetry(() => import("@/components/HospitalsRegistry").then(module => ({ default: module.HospitalsRegistry })));
const ExpensesDashboard = lazyWithRetry(() => import("./components/ExpensesDashboard").then(module => ({ default: module.ExpensesDashboard })));
const EquipmentsDashboard = lazyWithRetry(() => import("./components/EquipmentsDashboard").then(module => ({ default: module.EquipmentsDashboard })));
const HospitalDetails = lazyWithRetry(() => import("@/components/HospitalDetails").then(module => ({ default: module.HospitalDetails })));
const AuditLogs = lazyWithRetry(() => import("@/components/AuditLogs").then(module => ({ default: module.AuditLogs })));
const ClinicAttendance = lazyWithRetry(() => import("@/components/ClinicAttendance").then(module => ({ default: module.ClinicAttendance })));
const ShiftManagement = lazyWithRetry(() => import("@/components/ShiftManagement").then(module => ({ default: module.ShiftManagement })));
const HospitalShiftManagement = lazyWithRetry(() => import("@/components/HospitalShiftManagement").then(module => ({ default: module.HospitalShiftManagement })));
const EarningsDashboard = lazyWithRetry(() => import("@/components/EarningsDashboard").then(module => ({ default: module.EarningsDashboard })));
const SettingsDashboard = lazyWithRetry(() => import("@/components/SettingsDashboard").then(module => ({ default: module.SettingsDashboard })));
const CAFinancialSuite = lazyWithRetry(() => import("@/components/CAFinancialSuite").then(module => ({ default: module.CAFinancialSuite })));

import { HashRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import LandingPage from '@/pages/LandingPage';
import { BillingOverview, SubscriptionDashboard } from '@/components/billing';
const AboutPage = lazyWithRetry(() => import("@/pages/AboutPage"));
const NewsPage = lazyWithRetry(() => import("@/pages/NewsPage"));
const ContactPage = lazyWithRetry(() => import("@/pages/ContactPage"));
const ClinicOperationsPage = lazyWithRetry(() => import("@/pages/ClinicOperationsPage"));
const HospitalCommandCenterPage = lazyWithRetry(() => import("@/pages/HospitalCommandCenterPage"));
const PrivacyPage = lazyWithRetry(() => import("@/pages/PrivacyPage"));
const CareersPage = lazyWithRetry(() => import("@/pages/CareersPage"));
const SupportPage = lazyWithRetry(() => import("@/pages/SupportPage"));
import { useLocation } from 'react-router-dom';
import { logPageView } from '@/lib/analytics';
import { motion, AnimatePresence } from 'framer-motion';
import { pageVariants } from '@/lib/transitions';

import { Shield, RefreshCw, AlertTriangle } from 'lucide-react';
import { Button, WorkspaceSkeleton, DashboardSkeleton } from '@/components/ui/basic';
import { Toaster } from '@/components/ui/toaster';
import { authService } from '@/lib/authService';
import { dataService } from '@/lib/dataService';

// View types for Domain 1 (Operations & Administration)
type View = 'selection' | 'staff' | 'admin' | 'setup' | 'hospitals' | 'audit_logs' | 'attendance' | 'earnings' | 'settings' | 'billing' | 'shift-management' | 'expenses' | 'equipments' | 'ca-suite' | 'clinic-admin';

type SeoConfig = {
    title: string;
    description: string;
    path: string;
    robots: 'index, follow' | 'noindex, nofollow';
};

const SEO_BASE_URL = 'https://www.jeevika.in';
const DEFAULT_SEO: SeoConfig = {
    title: 'JEEVIKA | Hospital Business Operations & Governance',
    description: 'A complete hospital management system focused on core business operations, staff attendance, shift management, and CA balance sheets.',
    path: '/',
    robots: 'index, follow'
};

const SEO_ROUTES: Record<string, SeoConfig> = {
    '/': DEFAULT_SEO,
    '/about': { title: 'About JEEVIKA | Hospital Operations Platform', description: 'Operations platform for healthcare.', path: '/about', robots: 'index, follow' },
    '/news': { title: 'JEEVIKA News | Hospital Insights', description: 'Insights on operations.', path: '/news', robots: 'index, follow' },
    '/contact': { title: 'Contact JEEVIKA | Hospital Management Support', description: 'Support for hospitals.', path: '/contact', robots: 'index, follow' },
    '/clinic-operations': { title: 'Clinic Operations Management | JEEVIKA', description: 'Clinic operations.', path: '/clinic-operations', robots: 'index, follow' },
    '/hospital-command-center': { title: 'Hospital Command Center | JEEVIKA', description: 'Command center.', path: '/hospital-command-center', robots: 'index, follow' },
    '/privacy': { title: 'Privacy Policy | JEEVIKA', description: 'Privacy policy.', path: '/privacy', robots: 'index, follow' },
    '/careers': { title: 'Careers at JEEVIKA', description: 'Careers at JEEVIKA.', path: '/careers', robots: 'index, follow' },
    '/support': { title: 'Support | JEEVIKA', description: 'Support.', path: '/support', robots: 'index, follow' },
    '/login': { title: 'Login | JEEVIKA', description: DEFAULT_SEO.description, path: '/login', robots: 'noindex, nofollow' },
    '/register': { title: 'Register | JEEVIKA', description: DEFAULT_SEO.description, path: '/register', robots: 'noindex, nofollow' }
};

const PageWrapper = ({ children }: { children: React.ReactNode }) => (
    <motion.div
        variants={pageVariants}
        initial="initial"
        animate="animate"
        exit="exit"
        className="w-full h-full"
    >
        {children}
    </motion.div>
);

function AppContent() {
    const { session, profile, loading, clinics } = useHospital();
    const isHospitalAdmin = profile?.role === 'HOSPITAL_ADMIN' || profile?.role === 'ADMIN';
    const location = useLocation();

    const queryParams = new URLSearchParams(location.search);
    const viewParam = queryParams.get('view') as View | null;

    const [view, setView] = useState<View>(() => {
        if (viewParam) return viewParam;
        const savedView = localStorage.getItem('lastActiveView') as View;
        return savedView || 'admin';
    });

    const [selectedClinicId, setSelectedClinicId] = useState<string | null>(() => {
        if (viewParam === 'clinic-admin' && clinics.length > 0) {
            return clinics[0].id;
        }
        return null;
    });

    useEffect(() => {
        if (viewParam && viewParam !== view) {
            setView(viewParam);
            if (viewParam === 'admin') {
                setSelectedClinicId(null);
            } else if (viewParam === 'clinic-admin' && clinics.length > 0) {
                setSelectedClinicId(clinics[0].id);
            }
        }
    }, [viewParam, clinics]);

    useEffect(() => {
        if (view) {
            localStorage.setItem('lastActiveView', view);
        }
    }, [view]);

    useEffect(() => {
        if (!loading && profile) {
            if (profile.role === 'CLINIC_ADMIN') {
                const clinicAdminViews: View[] = ['admin', 'staff', 'attendance', 'shift-management', 'settings', 'clinic-admin'];
                if (!clinicAdminViews.includes(view)) {
                    setView('admin');
                }
                return;
            }

            if ((profile.role === 'ADMIN' || profile.role === 'HOSPITAL_ADMIN') && !profile.hospital_id) {
                if (view !== 'setup') setView('setup');
            } else if (['ADMIN', 'HOSPITAL_ADMIN'].includes(profile.role)) {
                const hospitalAdminViews: View[] = ['admin', 'staff', 'shift-management', 'earnings', 'billing', 'expenses', 'equipments', 'ca-suite', 'settings', 'setup', 'attendance', 'clinic-admin'];
                if (!hospitalAdminViews.includes(view)) {
                    setView('admin');
                }
            } else if (['SUPER_ADMIN', 'OWNER'].includes(profile.role)) {
                const superAdminViews: View[] = ['admin', 'hospitals', 'audit_logs', 'billing', 'settings'];
                if (!superAdminViews.includes(view)) {
                    setView('admin');
                }
            } else if (view === 'selection' || (view === 'setup' && profile.hospital_id)) {
                setView('admin');
            }
        } else if (!loading && !session) {
            setView('selection');
        }
    }, [loading, profile, session]);

    const [selectedHospitalId, setSelectedHospitalId] = useState<string | null>(null);

    const navigateToHospital = (id: string) => {
        setSelectedHospitalId(id);
        setView('hospitals');
    };

    const handleBackFromDetails = () => {
        setSelectedHospitalId(null);
    };

    const guardedSetView = (nextView: View) => {
        setView(nextView);
    };

    const handleLogout = async () => {
        try {
            await authService.signOut();
        } catch (err) {
            console.warn('Sign out error:', err);
        } finally {
            localStorage.removeItem('lastActiveView');
            Object.keys(localStorage).forEach(key => {
                if (key.startsWith('sb-') || key.includes('supabase') || key.includes('auth')) {
                    localStorage.removeItem(key);
                }
            });
            window.location.href = window.location.origin + window.location.pathname + '#/login';
        }
    };

    return (
        <AppLayout
            onLogout={handleLogout}
            view={view as any}
            setView={guardedSetView as any}
            lockNavigation={view === 'setup'}
            selectedClinicId={selectedClinicId}
            onSelectClinicId={setSelectedClinicId}
        >
            <Suspense fallback={<DashboardSkeleton />}>
                <AnimatePresence mode="wait">
                    <PageWrapper key={view}>
                        {view === 'selection' && !loading && profile && !['ADMIN', 'CLINIC_STAFF', 'SUPER_ADMIN', 'HOSPITAL_ADMIN', 'CLINIC_ADMIN', 'DOCTOR'].includes(profile?.role || '') && (
                            <div className="flex flex-col items-center justify-center p-12 text-center h-full">
                                <Shield className="w-20 h-20 text-slate-200 mb-6" />
                                <h1 className="text-3xl font-bold text-slate-900">Access Restricted</h1>
                                <p className="text-slate-500 max-w-md mt-2">
                                    Your account ({profile.email}) is active but has no assigned role.
                                </p>
                            </div>
                        )}

                        {view === 'staff' && <StaffPortal />}
                        {view === 'earnings' && <EarningsDashboard />}
                        
                        {view === 'attendance' && selectedClinicId && (
                            <ClinicAttendance clinicId={selectedClinicId} onNavigate={(v: string) => setView(v as View)} />
                        )}
                        {view === 'attendance' && profile?.role === 'CLINIC_ADMIN' && profile.clinic_id && (
                            <ClinicAttendance clinicId={profile.clinic_id} onNavigate={(v: string) => setView(v as View)} />
                        )}

                        {view === 'shift-management' && (
                            (['HOSPITAL_ADMIN', 'ADMIN'].includes(profile?.role || '')) ? (
                                <HospitalShiftManagement />
                            ) : (
                                profile?.clinic_id ? (
                                    <ShiftManagement clinicId={profile.clinic_id} />
                                ) : (
                                    <div className="p-12 text-center text-slate-500">No Clinic Selected</div>
                                )
                            )
                        )}

                        {view === 'admin' && (
                            <>
                                {(['SUPER_ADMIN', 'OWNER'].includes(profile?.role || '')) && (
                                    <SuperAdminDashboard onView={navigateToHospital} />
                                )}

                                {(['HOSPITAL_ADMIN', 'ADMIN'].includes(profile?.role || '')) && (
                                    selectedClinicId ? (
                                        <ClinicAdminDashboard clinicId={selectedClinicId} onBack={() => setSelectedClinicId(null)} onNavigate={setView as any} />
                                    ) : (
                                        <HospitalDashboard onSelectClinic={setSelectedClinicId} />
                                    )
                                )}

                                {(profile?.role === 'CLINIC_ADMIN') && (
                                    profile.clinic_id ? (
                                        <ClinicAdminDashboard clinicId={profile.clinic_id} onNavigate={setView as any} />
                                    ) : (
                                        <div className="p-12 text-center text-slate-500">
                                            <h2 className="text-xl font-bold text-slate-800">No Clinic Assigned</h2>
                                            <p className="mb-4">Please contact your Hospital Administrator.</p>
                                        </div>
                                    )
                                )}
                            </>
                        )}

                        {view === 'setup' && (
                            <AdminSetup userProfile={profile} onComplete={() => window.location.reload()} />
                        )}

                        {view === 'hospitals' && (
                            selectedHospitalId ? (
                                <HospitalDetails hospitalId={selectedHospitalId} onBack={handleBackFromDetails} />
                            ) : (
                                <HospitalsRegistry onView={navigateToHospital} />
                            )
                        )}

                        {view === 'audit_logs' && <AuditLogs />}

                        {view === 'billing' && (
                            <div className="max-w-4xl mx-auto">
                                {['SUPER_ADMIN', 'OWNER'].includes(profile?.role || '') ? (
                                    <BillingOverview />
                                ) : (
                                    <SubscriptionDashboard />
                                )}
                            </div>
                        )}

                        {view === 'expenses' && <ExpensesDashboard />}
                        {view === 'equipments' && <EquipmentsDashboard />}
                        {view === 'ca-suite' && <CAFinancialSuite />}

                        {view === 'clinic-admin' && (
                            <ClinicAdminDashboard 
                                clinicId={selectedClinicId || profile?.clinic_id || clinics[0]?.id || 'clinic-main'} 
                                onBack={() => {
                                    setSelectedClinicId(null);
                                    setView('admin');
                                }} 
                                onNavigate={setView as any} 
                            />
                        )}

                        {view === 'settings' && <SettingsDashboard />}
                    </PageWrapper>
                </AnimatePresence>
            </Suspense>
            <Toaster />
        </AppLayout>
    );
}

function AnalyticsTracker() {
    const location = useLocation();
    useEffect(() => {
        const path = location.pathname + location.search + location.hash;
        logPageView(path);
    }, [location]);
    return null;
}

function SeoManager() {
    const location = useLocation();
    useEffect(() => {
        const currentPath = location.pathname.startsWith('/app') ? '/app/*' : location.pathname;
        const seoConfig = SEO_ROUTES[currentPath] || DEFAULT_SEO;
        document.title = seoConfig.title;
    }, [location.pathname]);
    return null;
}

function AppRouter() {
    const { loading, isPasswordRecovery } = useHospital();
    const location = useLocation();

    if (loading) return <WorkspaceSkeleton />;

    const isResetPath = window.location.hash.startsWith('#/reset-password');
    if (isPasswordRecovery || isResetPath) {
        return (
            <>
                <ResetPasswordPage />
                <Toaster />
            </>
        );
    }

    return (
        <>
            <SeoManager />
            <AnalyticsTracker />
            <AnimatePresence mode="wait">
                <Routes location={location} key={location.pathname}>
                    <Route path="/" element={<PageWrapper><LandingPage /></PageWrapper>} />
                    <Route path="/about" element={<PageWrapper><AboutPage /></PageWrapper>} />
                    <Route path="/news" element={<PageWrapper><NewsPage /></PageWrapper>} />
                    <Route path="/contact" element={<PageWrapper><ContactPage /></PageWrapper>} />
                    <Route path="/clinic-operations" element={<PageWrapper><ClinicOperationsPage /></PageWrapper>} />
                    <Route path="/hospital-command-center" element={<PageWrapper><HospitalCommandCenterPage /></PageWrapper>} />
                    <Route path="/privacy" element={<PageWrapper><PrivacyPage /></PageWrapper>} />
                    <Route path="/careers" element={<PageWrapper><CareersPage /></PageWrapper>} />
                    <Route path="/support" element={<PageWrapper><SupportPage /></PageWrapper>} />
                    <Route path="/login" element={<Navigate to="/app" />} />
                    <Route path="/register" element={<Navigate to="/app" />} />
                    <Route path="/kiosk" element={<div className="p-12 text-center text-slate-500">Patient Kiosk module is available in Clinical Care (Folder 2).</div>} />
                    <Route path="/app/*" element={<AppContent />} />
                    <Route path="*" element={<Navigate to="/" />} />
                </Routes>
            </AnimatePresence>
        </>
    );
}

interface ErrorBoundaryProps { children: ReactNode; }
interface ErrorBoundaryState { hasError: boolean; error: Error | null; }

class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
    public state: ErrorBoundaryState = { hasError: false, error: null };
    public static getDerivedStateFromError(error: Error): ErrorBoundaryState {
        return { hasError: true, error };
    }
    public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
        console.error("Uncaught error:", error, errorInfo);
    }
    public render() {
        if (this.state.hasError) {
            return (
                <div className="flex flex-col items-center justify-center min-h-screen p-6 bg-slate-50 text-slate-800 text-center">
                    <AlertTriangle className="w-16 h-16 text-rose-500 mb-4 animate-bounce" />
                    <h2 className="text-2xl font-bold mb-2">Something went wrong</h2>
                    <p className="text-slate-500 max-w-md mb-6">{this.state.error?.message || "An unexpected error occurred."}</p>
                    <Button onClick={() => window.location.reload()} className="flex items-center gap-2">
                        <RefreshCw className="w-4 h-4" /> Reload Portal
                    </Button>
                </div>
            );
        }
        return this.props.children;
    }
}

export default function App() {
    return (
        <Router>
            <WebsiteLocalizationRuntime />
            <TourProvider>
                <ProductTour />
                <HospitalProvider>
                    <ErrorBoundary>
                        <Suspense fallback={<WorkspaceSkeleton />}>
                            <AppRouter />
                        </Suspense>
                    </ErrorBoundary>
                </HospitalProvider>
            </TourProvider>
        </Router>
    );
}
