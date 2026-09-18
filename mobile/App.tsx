import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  Alert,
  Animated,
  AppState,
  BackHandler,
  Easing,
  FlatList,
  InteractionManager,
  KeyboardAvoidingView,
  Linking,
  Modal,
  PanResponder,
  Platform,
  SafeAreaView,
  ScrollView,
  SectionList,
  StyleSheet,
  Switch,
  Text,
  TextInput,
  type TextInputProps,
  TouchableOpacity,
  useWindowDimensions,
  View,
} from "react-native";
import * as WebBrowser from "expo-web-browser";
import * as Notifications from "expo-notifications";
import * as DocumentPicker from "expo-document-picker";
import { Ionicons } from "@expo/vector-icons";
import { ApiError, api, authenticatedRead, responseCache, sessionStorage } from "./src/api";
import { appendGroupedCatalogPage, catalogCardKind, type GroupedCatalogPage } from "./src/catalog";
import { boundedCatalogText, compactLocations, presentCatalogRole, seasonLabel } from "./src/catalog-quality";
import { housingLabels, type DisplayHousingDetail } from "../shared/housing-display";
import { catalogDayIndexParameters, catalogFilterTokens, catalogGroupAvailabilityLabel, catalogRequestState, countActiveCatalogFilters, disciplineChipOptions, educationFilterOptions, emptyCatalogFilters, employerCategoryLabels, groupedCatalogParameters, releaseDayLabel, seasonFilterOptions, sourceFilterOptions, workModeFilterOptions, type CatalogFilterValues, type ChipOption } from "./src/catalog-filters";
import { calendarToday, monthCells, monthLabel, monthOf, monthRange, shiftMonth, weekdayInitials } from "./src/release-calendar";
import { UTC_ZONE, deviceTimeZone, useDayZone } from "./src/day-zone";
import { allDisciplineStyles, disciplineStyleFor } from "../shared/discipline-display";
import { createLatestRequestGuard } from "./src/latest-request";
import { uploadDocumentContent } from "./src/document-upload";
import { installationApi } from "./src/installation";
import { migrateLegacyAccountAlerts } from "./src/legacy-alert-migration";
import { buildCompleteDataExport, DataExportFetchError, SharingUnavailableError, type AccountExportResponse } from "./src/account-data-export";
import { accountDataActionState } from "./src/account-data-controls";
import { shareDataExport } from "./src/account-data-share";
import { clearSession, confirmEmail, restoreSession, signIn, signOut, signUp } from "./src/auth";
import { policyUrls } from "./src/policies";
import {
  clearApplicationFollowUp,
  notifyApplicationProgress,
  registerForJobAlerts,
  scheduleApplicationFollowUp,
} from "./src/notifications";
import {
  destinationFromNotification,
  destinationFromUrl,
  freshnessLabel,
  isNewJob,
  jobDetailPresentation,
  jobOpenDisposition,
  postingTimingPresentation,
  postingRecencyBadge,
  routeFailureState,
  shouldPushJobHistory,
  sourcePresentation,
  validatedOfficialUrl,
  type AppDestination,
  type FilterMatchReason,
  type JobRouteState,
} from "./src/job-detail";
import { applicationSections, applicationStatusLabel, nextAvailableQueueEntry, queueEntryTarget, resolveApplicationJob, selectBulkTargets, sortApplyQueue, type ApplicationJobSummary } from "./src/application";
import {
  appSettingsPayload,
  jobPreferencesPayload,
  settingsDraftSyncPlan,
  settingsDestinations,
  type SettingsDestination,
  type SettingsDraftRevisions,
} from "./src/settings";
import {
  employerApi,
  employerRouteFromUrl,
  employerStateExplanation,
  employerWorkspaceSections,
  type EmployerMember,
  type EmployerMetadataProposal,
  type EmployerOrganization,
  type EmployerSource,
  type EmployerSubmission,
  type EmployerWorkspaceSection,
} from "./src/employer";

WebBrowser.maybeCompleteAuthSession();

type Job = {
  jobId: string;
  company: string;
  title: string;
  location: string;
  locations?: string[];
  season: string;
  applyUrl: string;
  compensation: { raw: string };
  housing?: DisplayHousingDetail[];
  employerCategory?: EmployerCategory;
  requirements?: { requiresUsCitizenship: boolean; advancedDegreeRequired: boolean };
  disciplines?: string[];
  open: boolean;
  firstSeenAt: string;
  lastSeenAt: string;
  applicationUrlValidatedAt?: string;
  invalidApplicationUrl?: string;
  postingIdentityStatus?: "confirmed" | "unconfirmed";
  sourceReferences: Array<{
    sourceId: string;
    provenance?: "official-ats" | "official-structured" | "employer-submitted" | "reviewed-community";
    state?: "open" | "closed";
    sourceUrl: string;
    postedAt?: string;
    providerTimestamp?: { value: string; semantics: "published" | "updated" };
  }>;
};
type EmployerCategory = "faang" | "startup" | "normal";
type CatalogSource = "all" | "direct" | "community" | "corroborated";
type CatalogGroupKind = "program-group" | "employer-release" | "individual";
type CatalogEducation = { levels: string[]; evidence: "explicit" | "inferred" | "unspecified" | "conflicting"; label: string };
type CatalogGroupRow = {
  groupId: string;
  kind: CatalogGroupKind;
  company: string;
  seasons: string[];
  education: CatalogEducation[];
  roleCount: number;
  unconfirmedRoleCount: number;
  titles: string[];
  disciplines: string[];
  locations: string[];
  workModes: string[];
  createdAt: string;
  updatedAt: string;
  hasNewRoles: boolean;
  roleIds: string[];
  featuredRole: CatalogGroupRole;
  compensations: string[];
};
type CatalogGroupRole = {
  jobId: string;
  company: string;
  title: string;
  location: string;
  locations: string[];
  visibleAt: string;
  season: string;
  education: CatalogEducation;
  disciplines: string[];
  workModes: string[];
  sourceCredibility: "official" | "corroborated" | "community" | "unspecified";
  provenanceLabels?: string[];
  detailUrl: string;
  officialApplyUrl: string;
  applicationUrlValidated: boolean;
  open: boolean;
  employerCategory?: EmployerCategory;
  requiresUsCitizenship?: boolean;
  advancedDegreeRequired?: boolean;
  compensation: { raw: string };
  housing?: DisplayHousingDetail[];
  firstSeenAt: string;
  lastSeenAt: string;
  sourceReferences: Job["sourceReferences"];
  applicationUrlValidatedAt?: string;
  invalidApplicationUrl?: string;
  postingIdentityStatus?: "confirmed" | "unconfirmed";
};
type CatalogGroupDetails = { group: CatalogGroupRow; roles: CatalogGroupRole[] };
type Application = {
  applicationId: string;
  jobId: string;
  status: string;
  queuedAt?: string;
  createdAt?: string;
  appliedAt?: string;
  detection?: { source: "gmail"; detectedAt: string };
  notes?: string;
  job?: ApplicationJobSummary;
};
function isPendingApplicationId(applicationId: string): boolean {
  return applicationId.startsWith("pending-");
}
type GmailStatus = {
  connected: boolean;
  email?: string;
  state?: "syncing" | "connected" | "error";
  lastSuccessfulSync?: string;
  error?: { retryable: boolean; message: string };
};
type GmailDetection = {
  detectionId: string;
  receivedAt: string;
  sender: string;
  subject: string;
  candidates: Array<{ jobId: string; company: string; title: string; signals: string[] }>;
  reasons: string[];
};
type LaunchInbox = {
  jobs: Job[];
  groups?: CatalogGroupDetails[];
  total: number;
  hasMore: boolean;
  previousOpenedAt: string | null;
  openedAt: string;
};
type CatalogCache = GroupedCatalogPage<CatalogGroupRow>;
type CompanyCoverageState = "direct-published" | "direct-shadow" | "feed-observed" | "candidate-only";
type CompanyCoverageResponse = {
  generatedAt: string;
  methodology: string;
  counts: {
    companies: number;
    internshipObserved: number;
    directPublished: number;
    directShadow: number;
    feedObservedOnly: number;
    candidateOnly: number;
    activeListingObservations: number;
  };
  matchedCompanies: number;
  companies: Array<{
    companyId: string;
    displayName: string;
    coverageState: CompanyCoverageState;
    activeListingCount: number;
    directProviders: Array<"greenhouse" | "lever">;
  }>;
};
type JobFilter = {
  includeCategories?: string[];
  includeKeywords?: string[];
  excludeCategories?: string[];
  excludeKeywords?: string[];
  includeEmployerCategories?: EmployerCategory[];
  excludeEmployerCategories?: EmployerCategory[];
  excludeUsCitizenshipRequired?: boolean;
  excludeAdvancedDegreeRequired?: boolean;
};
type PushPreferences = {
  titleTemplate?: string;
  descriptionTemplate?: string;
  roleAbbreviations?: Record<string, string>;
};
type AlertSettings = {
  delivery: "immediate" | "daily-digest";
  timezone?: string;
  quietHours?: { start: string; end: string; timezone: string };
  applicationReminders: boolean;
  followUpDays: number;
};
type ApplicationHandoff = "window" | "tab";
type Preference = {
  filter: JobFilter;
  alertsEnabled: boolean;
  emailAlertsEnabled?: boolean;
  onboardingComplete: boolean;
  applicationHandoff?: ApplicationHandoff;
  alertSettings?: AlertSettings;
  push?: PushPreferences;
};
const defaultAlertSettings: AlertSettings = {
  delivery: "immediate",
  applicationReminders: true,
  followUpDays: 7,
};
const defaultPreference: Preference = {
  filter: {},
  alertsEnabled: false,
  onboardingComplete: true,
  alertSettings: defaultAlertSettings,
};
const catalogCacheKey = "internnotifs.grouped-catalog.v4";
const hiddenRolesCacheKey = "internnotifs.hidden-roles.v1";
const nextApplicationStatuses: Record<string, Application["status"]> = {
  saved: "applied",
  applied: "assessment",
  assessment: "interview",
  interview: "offer",
  offer: "offer",
  rejected: "rejected",
  withdrawn: "withdrawn",
};
const categories = ["ai-ml", "grad", "swe", "quant", "product", "design"];
const pushPlaceholders = [
  "{title}",
  "{shortTitle}",
  "{company}",
  "{location}",
  "{season}",
  "{compensation}",
  "{compensationDetail}",
  "{focus}",
  "{posted}",
  "{postedDetail}",
  "{source}",
  "{url}",
];
const colors = {
  canvas: "#F2F2F7",
  surface: "#FFFFFF",
  ink: "#1C1C1E",
  body: "#3A3A3C",
  muted: "#6C6C70",
  placeholder: "#475569",
  border: "#D1D1D6",
  separator: "#E5E5EA",
  signal: "#0E7490",
  signalSoft: "#E6F6F8",
  signalGlow: "#67E8F9",
  onDark: "#FFFFFF",
  overlay: "rgba(15, 23, 42, 0.44)",
  dangerSoft: "#FEF1F0",
  dangerBorder: "#F2AAA4",
  successSoft: "#ECFDF3",
  successBorder: "#86D6A5",
  success: "#067647",
  danger: "#B42318",
};
if (Platform.OS === 'web' && typeof document !== 'undefined') {
  document.documentElement.style.backgroundColor = colors.canvas;
  document.body.style.backgroundColor = colors.canvas;
}
const MotionAllowedContext = createContext(false);

function useMotionAllowed() {
  // Start enabled so the first interaction does not render without motion and
  // then restart its transition when the async accessibility check resolves.
  const [motionAllowed, setMotionAllowed] = useState(true);
  useEffect(() => {
    let mounted = true;
    void AccessibilityInfo.isReduceMotionEnabled()
      .then((reduceMotion) => {
        if (mounted) setMotionAllowed(!reduceMotion);
      })
      .catch(() => {
        if (mounted) setMotionAllowed(true);
      });
    const subscription = AccessibilityInfo.addEventListener(
      "reduceMotionChanged",
      (reduceMotion) => setMotionAllowed(!reduceMotion),
    );
    return () => {
      mounted = false;
      subscription.remove();
    };
  }, []);
  return motionAllowed;
}

function useSheetEntranceOffset(visible: boolean) {
  const motionAllowed = useContext(MotionAllowedContext);
  const entranceDistance = Platform.OS === "web" ? 40 : 72;
  const entranceDuration = Platform.OS === "web" ? 180 : 240;
  const offset = useRef(new Animated.Value(entranceDistance)).current;
  useLayoutEffect(() => {
    if (!visible) {
      offset.setValue(entranceDistance);
      return;
    }
    if (!motionAllowed) {
      offset.setValue(0);
      return;
    }
    offset.setValue(entranceDistance);
    const animation = Animated.timing(offset, {
      toValue: 0,
      duration: entranceDuration,
      easing: Easing.bezier(0.16, 1, 0.3, 1),
      useNativeDriver: true,
    });
    animation.start();
    return () => animation.stop();
  }, [entranceDistance, entranceDuration, motionAllowed, offset, visible]);
  return offset;
}

function useRoleSheetTransition(visible: boolean, onDismiss: () => void) {
  const motionAllowed = useContext(MotionAllowedContext);
  const entranceDistance = Platform.OS === "web" ? 40 : 72;
  const [modalVisible, setModalVisible] = useState(visible);
  const dimOpacity = useRef(new Animated.Value(0)).current;
  const sheetOffset = useRef(new Animated.Value(entranceDistance)).current;
  const closing = useRef(false);

  const animateClose = (afterClose?: () => void) => {
    if (!motionAllowed) {
      dimOpacity.setValue(0);
      sheetOffset.setValue(entranceDistance);
      setModalVisible(false);
      afterClose?.();
      return;
    }
    closing.current = true;
    Animated.parallel([
      Animated.timing(dimOpacity, {
        toValue: 0,
        duration: 160,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(sheetOffset, {
        toValue: entranceDistance,
        duration: 200,
        easing: Easing.in(Easing.quad),
        useNativeDriver: true,
      }),
    ]).start(({ finished }) => {
      if (!finished) return;
      closing.current = false;
      setModalVisible(false);
      afterClose?.();
    });
  };

  useEffect(() => {
    if (!visible) {
      if (modalVisible && !closing.current) animateClose();
      return;
    }
    setModalVisible(true);
    if (!motionAllowed) {
      dimOpacity.setValue(1);
      sheetOffset.setValue(0);
      return;
    }
    dimOpacity.setValue(0);
    sheetOffset.setValue(entranceDistance);
    const animation = Animated.parallel([
      Animated.timing(dimOpacity, {
        toValue: 1,
        duration: 220,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
      Animated.timing(sheetOffset, {
        toValue: 0,
        duration: 280,
        easing: Easing.out(Easing.quad),
        useNativeDriver: true,
      }),
    ]);
    animation.start();
    return () => animation.stop();
  }, [dimOpacity, entranceDistance, motionAllowed, sheetOffset, visible]);

  return {
    modalVisible,
    dimOpacity,
    sheetOffset,
    dismiss: () => {
      if (closing.current) return;
      animateClose(onDismiss);
    },
  };
}

function openWebApplication(url: string, handoff: ApplicationHandoff) {
  if (handoff === "tab") return window.open(url, "_blank");
  const width = window.screen?.availWidth || window.innerWidth;
  const height = window.screen?.availHeight || window.innerHeight;
  return window.open(url, "_blank", `popup=yes,width=${width},height=${height},left=0,top=0`);
}

async function openOfficialApplication(
  url: string,
  handoff: ApplicationHandoff = "window",
  onOpened?: () => void,
) {
  if (!/^https:\/\//i.test(url)) {
    Alert.alert(
      "Application link unavailable",
      "This role does not have a valid official application link yet.",
    );
    return;
  }

  if (Platform.OS === "web" && typeof window !== "undefined") {
    const applicationWindow = openWebApplication(url, handoff);
    if (applicationWindow) {
      applicationWindow.opener = null;
      onOpened?.();
    }
    else Alert.alert("Pop-up blocked", "Allow pop-ups for Ntern, then try opening the application again.");
    return;
  }

  try {
    onOpened?.();
    await WebBrowser.openBrowserAsync(url);
  } catch {
    Alert.alert(
      "Could not open application",
      "Please try again or open the employer's site from another device.",
    );
  }
}

type WebShortcut = {
  key: string;
  onPress: () => void;
  enabled?: boolean;
};

function useWebKeyboardShortcuts(shortcuts: WebShortcut[]) {
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target?.tagName ?? "")) return;
      const shortcut = shortcuts.find((candidate) => candidate.key === event.key.toLowerCase() && candidate.enabled !== false);
      if (!shortcut) return;
      event.preventDefault();
      shortcut.onPress();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [shortcuts]);
}

function JobSource({ source, showIdentityUnconfirmed = false }: { source: ReturnType<typeof sourcePresentation>; showIdentityUnconfirmed?: boolean }) {
  const icon = source.primary === "Employer submitted"
    ? "business-outline"
    : source.primary.startsWith("Official")
    ? "shield-checkmark-outline"
    : source.primary === "Reviewed community source"
      ? "people-outline"
      : "help-circle-outline";
  return (
    <View style={styles.jobSourceRow}>
      <Ionicons name={icon} size={14} color={colors.muted} />
      <Text style={styles.jobSourceText}>{source.primary}</Text>
      {source.corroboration ? <Text style={styles.jobSourceCorroboration}>{source.corroboration}</Text> : null}
      {showIdentityUnconfirmed ? (
        <>
          <Text style={styles.jobSourceText}>·</Text>
          <Ionicons name="shield-outline" size={14} color={colors.muted} />
          <Text style={styles.jobSourceText} accessibilityLabel="Identity unconfirmed">Identity unconfirmed</Text>
        </>
      ) : null}
    </View>
  );
}

function IdentityTrustLabel() {
  return (
    <View style={styles.identityTrustRow} accessibilityLabel="Identity unconfirmed">
      <Ionicons name="shield-outline" size={14} color={colors.muted} />
      <Text style={styles.identityTrustText}>Identity unconfirmed</Text>
    </View>
  );
}

function openAppSettings() {
  void Linking.openSettings().catch(() => {
    Alert.alert("Could not open Settings", "Open your device settings and select Ntern.");
  });
}

function showNotificationPermissionHelp() {
  Alert.alert(
    "Notifications are off",
    "Enable notifications for Ntern in your device settings, then try again.",
    [
      { text: "Not now", style: "cancel" },
      { text: "Open Settings", onPress: openAppSettings },
    ],
  );
}

function hasGreenhouseQuickApply(url: string) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === "boards.greenhouse.io"
      || host.endsWith(".boards.greenhouse.io")
      || host === "job-boards.greenhouse.io"
      || host.endsWith(".job-boards.greenhouse.io");
  } catch {
    return false;
  }
}
type CardGestureOptions = {
  /** Swipe left queues the role. */
  queueable: boolean;
  /** Swipe right hides the role on this device. */
  hideable: boolean;
  onQueue?: () => void;
  onHide?: () => void;
};

/**
 * The one swipe-and-hide behaviour behind every role card: swipe left to queue,
 * swipe right to hide, with the same reachable accessibility actions. Cards own
 * their own composition, never a private copy of this gesture.
 */
function useCardGestures({ queueable, hideable, onQueue, onHide }: CardGestureOptions) {
  const motionAllowed = useContext(MotionAllowedContext);
  // react-native-web has no native animated module, and an animation handed to the
  // native driver there never calls its completion callback — which is where the
  // hide and the swipe hand off to the list. Keep the driver on native only.
  const driver = Platform.OS !== "web";
  const translateX = useRef(new Animated.Value(0)).current;
  const hideFade = useRef(new Animated.Value(1)).current;
  const hideScale = useRef(new Animated.Value(1)).current;
  const hideTranslateY = useRef(new Animated.Value(0)).current;
  const [isHiding, setIsHiding] = useState(false);
  const handleHide = () => {
    if (isHiding || !onHide) return;
    setIsHiding(true);
    if (!motionAllowed) {
      onHide();
      return;
    }
    Animated.parallel([
      Animated.timing(hideFade, { toValue: 0, duration: 200, easing: Easing.bezier(0.22, 1, 0.36, 1), useNativeDriver: driver }),
      Animated.timing(hideScale, { toValue: 0.96, duration: 200, easing: Easing.bezier(0.22, 1, 0.36, 1), useNativeDriver: driver }),
      Animated.timing(hideTranslateY, { toValue: 6, duration: 200, easing: Easing.bezier(0.22, 1, 0.36, 1), useNativeDriver: driver }),
    ]).start(() => onHide());
  };
  const handleQueue = () => {
    if (isHiding || !onQueue) return;
    onQueue();
  };
  const resetPosition = () => {
    if (!motionAllowed) {
      translateX.setValue(0);
      return;
    }
    Animated.spring(translateX, {
      toValue: 0,
      friction: 9,
      tension: 130,
      useNativeDriver: driver,
    }).start();
  };
  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          ((queueable && gesture.dx < -8) || (hideable && gesture.dx > 8))
          && Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderMove: (_, gesture) => {
          translateX.setValue(
            Math.max(queueable ? -116 : 0, Math.min(hideable ? 116 : 0, gesture.dx)),
          );
        },
        onPanResponderRelease: (_, gesture) => {
          const shouldQueue = queueable && (gesture.dx < -84 || gesture.vx < -0.7);
          const shouldHide = hideable && (gesture.dx > 84 || gesture.vx > 0.7);
          if (!shouldQueue && !shouldHide) {
            resetPosition();
            return;
          }
          if (shouldQueue) onQueue?.();
          if (!motionAllowed) {
            translateX.setValue(0);
            if (shouldHide) onHide?.();
            return;
          }
          Animated.sequence([
            Animated.timing(translateX, {
              toValue: shouldQueue ? -108 : 108,
              duration: 100,
              easing: Easing.out(Easing.cubic),
              useNativeDriver: driver,
            }),
            Animated.delay(120),
          ]).start(() => {
            if (shouldHide) onHide?.();
            else resetPosition();
          });
        },
        onPanResponderTerminate: resetPosition,
      }),
    [hideable, isHiding, motionAllowed, onHide, onQueue, queueable, translateX],
  );
  const queueProgress = translateX.interpolate({
    inputRange: [-108, -36, 0],
    outputRange: [1, 0.32, 0],
    extrapolate: "clamp",
  });
  const hideProgress = translateX.interpolate({
    inputRange: [0, 36, 108],
    outputRange: [0, 0.32, 1],
    extrapolate: "clamp",
  });
  return {
    isHiding,
    handleHide,
    handleQueue,
    translateX,
    panHandlers: queueable || hideable ? panResponder.panHandlers : {},
    queueProgress,
    hideProgress,
    hideFade,
    hideScale,
    hideTranslateY,
  };
}

function JobCard({
  job,
  onOpen,
  applicationStatus,
  isQueued,
  isNew = false,
  onAddToQueue,
  isAddingToQueue = false,
  onHideLocally,
  onRemoveFromQueue,
}: {
  job: Job;
  onOpen: () => void;
  applicationStatus?: string;
  /** Explicit queue membership; defaults to saved status when omitted (guest). */
  isQueued?: boolean;
  isNew?: boolean;
  /** Adds this role to the apply queue. */
  onAddToQueue?: () => void;
  isAddingToQueue?: boolean;
  onHideLocally?: () => void;
  onRemoveFromQueue?: () => void;
}) {
  const display = presentCatalogRole(job);
  const { width } = useWindowDimensions();
  const compactMobile = width < 600;
  const source = sourcePresentation(job.sourceReferences);
  const canAddToQueue = Boolean(onAddToQueue) && !isAddingToQueue && (!applicationStatus || (applicationStatus === "saved" && !(isQueued ?? true)));
  const inQueue = isQueued ?? applicationStatus === "saved";
  const queueProgressLabel = inQueue ? "Removing…" : "Adding…";
  const canHideLocally = Boolean(onHideLocally);
  const postingTiming = postingTimingPresentation(job.sourceReferences, job.firstSeenAt);
  const recencyBadge = postingRecencyBadge(isNew, postingTiming);
  const {
    isHiding,
    handleHide,
    handleQueue,
    translateX,
    panHandlers,
    queueProgress,
    hideProgress,
    hideFade,
    hideScale,
    hideTranslateY,
  } = useCardGestures({ queueable: canAddToQueue, hideable: canHideLocally, onQueue: onAddToQueue, onHide: onHideLocally });
  const handleRemoveFromQueue = () => {
    if (isHiding || !onRemoveFromQueue) return;
    onRemoveFromQueue();
  };

  return (
    <Animated.View style={{ opacity: hideFade, transform: [{ scale: hideScale }, { translateY: hideTranslateY }] }}>
      <View style={styles.swipeCard}>
        {canAddToQueue || isAddingToQueue ? (
          <Animated.View
            pointerEvents="none"
            style={[styles.swipeSaveAction, { opacity: queueProgress }]}
          >
            <Ionicons name="bookmark" size={20} color="#FFFFFF" />
            <Text style={styles.swipeSaveActionText}>{isAddingToQueue ? queueProgressLabel : "Mark"}</Text>
          </Animated.View>
        ) : null}
        {canHideLocally ? (
          <Animated.View
            pointerEvents="none"
            style={[styles.swipeHideAction, { opacity: hideProgress }]}
          >
            <Ionicons name="eye-off-outline" size={20} color={colors.onDark} />
            <Text style={styles.swipeHideActionText}>Hide</Text>
          </Animated.View>
        ) : null}
        <Animated.View
          {...panHandlers}
          style={{ transform: [{ translateX }] }}
        >
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`${recencyBadge ? `${recencyBadge} role, ` : ""}${display.title} at ${display.company}, ${display.location}, ${postingTiming.summary}, ${source.primary}${source.corroboration ? ", corroborated by a community listing" : ""}${job.postingIdentityStatus === "unconfirmed" ? ", identity unconfirmed" : ""}${applicationStatus ? `, ${applicationStatus}` : ""}`}
            accessibilityHint={
              canAddToQueue && canHideLocally
                ? "Swipe left to add this role to the apply queue, or swipe right to hide it on this device."
                : canAddToQueue
                  ? "Swipe left to add this role to the queue and apply later."
                  : canHideLocally
                    ? "Swipe right to hide this role on this device."
                    : undefined
            }
            accessibilityActions={
              [
                ...(canAddToQueue ? [{ name: "queue", label: "Add to apply queue" }] : []),
                ...(inQueue && onRemoveFromQueue ? [{ name: "removeFromQueue", label: "Remove from queue" }] : []),
                ...(canHideLocally ? [{ name: "hide", label: "Hide on this device" }] : []),
              ]
            }
            onAccessibilityAction={(event) => {
              if (event.nativeEvent.actionName === "queue") handleQueue();
              if (event.nativeEvent.actionName === "removeFromQueue") handleRemoveFromQueue();
              if (event.nativeEvent.actionName === "hide") handleHide();
            }}
            style={[styles.card, styles.swipeCardSurface, compactMobile && styles.mobileRoleCard]}
            onPress={onOpen}
          >
            <View style={styles.jobCompanyRow}>
              <View style={styles.jobCompanyLeft}>
                <Text style={styles.company} numberOfLines={1}>{display.company}</Text>
                {recencyBadge ? (
                  <View style={styles.newSpark} accessibilityLabel={`${recencyBadge} role`}>
                    <Ionicons name="sparkles-outline" size={13} color={colors.signal} />
                    <Text style={styles.newSparkText}>{recencyBadge}</Text>
                  </View>
                ) : null}
              </View>
              {job.disciplines?.length ? (
                <View style={styles.jobCardTopTags}>
                  {job.disciplines.slice(0, 2).map((d) => {
                    const s = disciplineStyleFor(d);
                    return (
                      <View key={d} style={[styles.disciplinePill, { backgroundColor: s.backgroundColor, borderColor: s.borderColor }]}>
                        <Text style={[styles.disciplinePillText, { color: s.color }]}>{s.label}</Text>
                      </View>
                    );
                  })}
                </View>
              ) : null}
            </View>
            <Text style={[styles.title, compactMobile && styles.mobileRoleTitle]} numberOfLines={2}>{display.title}</Text>
            <Text style={[styles.muted, compactMobile && styles.mobileRoleMeta]} numberOfLines={3}>
              {display.location} · {display.season}
              {display.compensation ? <Text style={styles.payInline}> · {display.compensation}</Text> : null}
            </Text>
            <View style={compactMobile && styles.mobileRoleSource}><JobSource source={source} showIdentityUnconfirmed={job.postingIdentityStatus === "unconfirmed"} /></View>
            <Text style={[styles.postingTiming, compactMobile && styles.mobileRoleTiming]}>{postingTiming.summary}</Text>
            {!job.open ? <Text style={styles.closedStatus}>Closed</Text> : null}
            <View style={[styles.jobCardFooterLeft, compactMobile && styles.mobileRoleFooter]}>
              <View style={styles.jobCardActionCompact}>
                <Text style={styles.jobCardActionText}>View role</Text>
                <Text style={styles.jobCardActionArrow}>›</Text>
              </View>
              <View style={styles.jobCardBottomActions}>
                {canHideLocally ? (
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Hide on this device" onPress={handleHide} style={styles.webHideButtonCompact}>
                    <Ionicons name="eye-off-outline" size={14} color={colors.muted} />
                    <Text style={styles.webHideButtonText}>Hide</Text>
                  </TouchableOpacity>
                ) : null}
                {!isAddingToQueue && inQueue && onRemoveFromQueue ? (
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Remove from queue" onPress={handleRemoveFromQueue} style={styles.webInQueueButtonCompact}>
                    <Ionicons name="bookmark" size={14} color={colors.signal} />
                    <Text style={styles.webInQueueButtonText}>In queue</Text>
                  </TouchableOpacity>
                ) : null}
                {isAddingToQueue ? (
                  <View style={styles.webQueueButtonCompact}>
                    <Text style={styles.webQueueButtonText}>{queueProgressLabel}</Text>
                  </View>
                ) : null}
                {canAddToQueue ? (
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Add to apply queue" accessibilityHint="Adds this role to the apply queue" onPress={handleQueue} style={styles.webQueueButtonCompact}>
                    <Ionicons name="bookmark" size={14} color={colors.ink} />
                    <Text style={styles.webQueueButtonText}>Queue</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

function catalogRoleJob(role: CatalogGroupRole): Job {
  return {
    jobId: role.jobId,
    company: role.company,
    title: role.title,
    location: role.location,
    locations: role.locations,
    season: role.season,
    applyUrl: role.officialApplyUrl,
    compensation: role.compensation ?? { raw: "" },
    housing: role.housing,
    employerCategory: role.employerCategory,
    requirements: {
      requiresUsCitizenship: Boolean(role.requiresUsCitizenship),
      advancedDegreeRequired: Boolean(role.advancedDegreeRequired),
    },
    disciplines: role.disciplines,
    open: role.open,
    firstSeenAt: role.firstSeenAt ?? role.visibleAt,
    lastSeenAt: role.lastSeenAt ?? role.visibleAt,
    sourceReferences: role.sourceReferences ?? [],
    ...(role.applicationUrlValidatedAt ? { applicationUrlValidatedAt: role.applicationUrlValidatedAt } : {}),
    ...(role.invalidApplicationUrl ? { invalidApplicationUrl: role.invalidApplicationUrl } : {}),
    ...(role.postingIdentityStatus ? { postingIdentityStatus: role.postingIdentityStatus } : {}),
  };
}

type ReleaseDayCount = { day: string; roles: number; employers: number };

/**
 * The release calendar: which days the catalog actually published roles, and a
 * one-tap filter to the day a reader picks. Counts come from the same rule the
 * filter uses, so a filled day always has something to show.
 */
/** The release-day control. The panel it opens is rendered by the search block
 * rather than by this control, so a phone can expand it in place instead of
 * floating a card off a control that sits mid-row. */
function ReleaseCalendarTrigger({ open, selectedDay, onToggle }: { open: boolean; selectedDay?: string; onToggle: () => void }) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={selectedDay ? `Release day ${releaseDayLabel(selectedDay)}. Change release day` : "Filter by release day"}
      aria-expanded={open}
      onPress={onToggle}
      style={[styles.calendarTrigger, Boolean(selectedDay) && styles.calendarTriggerOn]}
    >
      <Ionicons name="calendar-outline" size={17} color={selectedDay ? colors.signal : colors.ink} />
      <Text style={[styles.calendarTriggerText, Boolean(selectedDay) && styles.calendarTriggerTextOn]} numberOfLines={1}>
        {selectedDay ? releaseDayLabel(selectedDay) : "Dates"}
      </Text>
    </TouchableOpacity>
  );
}

/**
 * The release calendar: which days the catalog actually published roles, and a
 * one-tap filter to the day a reader picks. Counts come from the same rule the
 * filter uses, so a filled day always has something to show.
 */
function ReleaseCalendarPanel({
  filters,
  zone,
  selectedDay,
  inline,
  onSelectDay,
  onClose,
}: {
  filters: CatalogFilterValues;
  zone: string;
  selectedDay?: string;
  /** In place under the search spine, instead of a card floating off the control. */
  inline: boolean;
  onSelectDay: (day: string | undefined) => void;
  onClose: () => void;
}) {
  const { width } = useWindowDimensions();
  const [month, setMonth] = useState(() => monthOf(selectedDay ?? calendarToday()));
  const [days, setDays] = useState<ReleaseDayCount[]>([]);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const today = calendarToday();
  useEffect(() => {
    let active = true;
    const range = monthRange(month);
    const params = catalogDayIndexParameters(filters, { ...range, dayZone: zone });
    setLoading(true);
    void api<{ days: ReleaseDayCount[] }>(`/catalog/days?${params.toString()}`, "")
      .then((response) => {
        if (!active) return;
        setDays(response.days);
        setFailed(false);
      })
      .catch(() => {
        if (!active) return;
        setDays([]);
        setFailed(true);
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [filters, month, zone]);
  const counts = useMemo(() => new Map(days.map((entry) => [entry.day, entry])), [days]);
  const selected = selectedDay ? counts.get(selectedDay) : undefined;
  const cells = monthCells(month);
  const popoverWidth = Math.min(320, width - 40);
  const panel = (
    <>
      <View style={styles.calendarHeader}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Previous month" onPress={() => setMonth((current) => shiftMonth(current, -1))} style={styles.calendarMonthButton}>
          <Ionicons name="chevron-back" size={18} color={colors.ink} />
        </TouchableOpacity>
        <Text style={styles.calendarMonth} accessibilityLiveRegion="polite">{monthLabel(month)}</Text>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Next month"
          disabled={shiftMonth(month, 1) > monthOf(today)}
          onPress={() => setMonth((current) => shiftMonth(current, 1))}
          style={styles.calendarMonthButton}
        >
          <Ionicons name="chevron-forward" size={18} color={shiftMonth(month, 1) > monthOf(today) ? colors.border : colors.ink} />
        </TouchableOpacity>
      </View>
      <View style={styles.calendarWeekdays}>
        {weekdayInitials.map((initial, index) => (
          <Text key={`${initial}-${index}`} style={styles.calendarWeekday}>{initial}</Text>
        ))}
      </View>
      <View style={styles.calendarGrid}>
        {cells.map((cell, index) => {
          if (!cell) return <View key={`blank-${index}`} style={styles.calendarCell} />;
          const entry = counts.get(cell.day);
          const isSelected = selectedDay === cell.day;
          const isToday = cell.day === today;
          if (!entry) {
            return (
              <View key={cell.day} style={styles.calendarCell}>
                <View style={[styles.calendarDay, styles.calendarDayEmpty, isToday && styles.calendarDayToday]}>
                  <Text style={styles.calendarDayMutedText}>{cell.dayOfMonth}</Text>
                </View>
              </View>
            );
          }
          return (
            <View key={cell.day} style={styles.calendarCell}>
              <TouchableOpacity
                accessibilityRole="button"
                aria-pressed={isSelected}
                accessibilityLabel={`${releaseDayLabel(cell.day)}, ${entry.roles} ${entry.roles === 1 ? "role" : "roles"} released`}
                onPress={() => {
                  onSelectDay(isSelected ? undefined : cell.day);
                  onClose();
                }}
                style={[styles.calendarDay, isToday && styles.calendarDayToday, isSelected && styles.calendarDaySelected]}
              >
                <Text style={[styles.calendarDayText, isSelected && styles.calendarDayTextSelected]}>{cell.dayOfMonth}</Text>
                <Text style={[styles.calendarDayCount, isSelected && styles.calendarDayTextSelected]}>{entry.roles}</Text>
              </TouchableOpacity>
            </View>
          );
        })}
      </View>
      <View style={styles.calendarFooter}>
        <Text style={styles.calendarZone} accessibilityLabel={`Release days are read in ${zone}`}>
          {zone === UTC_ZONE ? "UTC days" : `Device days · ${zone}`}
        </Text>
        {loading ? <Text style={styles.calendarFooterNote}>Checking days…</Text> : null}
        {!loading && failed ? <Text style={styles.calendarFooterNote}>Days unavailable</Text> : null}
        {!loading && !failed ? <Text style={styles.calendarFooterNote}>Number = roles released</Text> : null}
      </View>
      {selected ? (
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear release day" onPress={() => { onSelectDay(undefined); onClose(); }} style={styles.calendarClear}>
          <Text style={styles.calendarClearText}>
            Showing {releaseDayLabel(selected.day)} · {selected.roles} {selected.roles === 1 ? "role" : "roles"} — clear
          </Text>
        </TouchableOpacity>
      ) : null}
    </>
  );
  if (inline) {
    return <View style={styles.calendarInlinePanel} accessibilityLabel="Release calendar">{panel}</View>;
  }
  return (
    <>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close release calendar" onPress={onClose} style={styles.calendarScrim} />
      <View style={[styles.calendarPopover, { width: popoverWidth }]} accessibilityLabel="Release calendar">
        {panel}
      </View>
    </>
  );
}

type CatalogPresentation = "grid" | "lane";

type CatalogCardProps = {
  status: "open" | "closed";
  applicationStatuses?: Map<string, string>;
  queuedJobIds?: Set<string>;
  queuingJobIds?: Set<string>;
  /** Roles that appeared since the last visit; the tiles mark only these. */
  newJobIds?: Set<string>;
  onOpenGroup: (group: CatalogGroupRow) => void;
  onOpenRole: (job: Job) => void;
  onAddToQueue?: (job: Job) => void | Promise<boolean>;
  onHideLocally?: (job: Job) => void;
  onRemoveFromQueue?: (job: Job) => void;
};

function CatalogTileSkeleton({ count = 6, columns = 2 }: { count?: number; columns?: number }) {
  const rows: number[][] = [];
  for (let index = 0; index < count; index += columns) {
    rows.push(Array.from({ length: Math.min(columns, count - index) }, (_, offset) => index + offset));
  }
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Loading internships">
      {rows.map((row) => (
        <View key={row[0]} style={styles.catalogGridRow}>
          {row.map((index) => (
            <View key={index} style={styles.catalogTileSkeleton}>
              <Skeleton width={64} height={18} />
              <Skeleton width={150} height={13} />
              <Skeleton width={200} height={16} />
              <Skeleton width={170} height={13} />
              <Skeleton width={90} height={13} />
            </View>
          ))}
          {row.length < columns
            ? Array.from({ length: columns - row.length }, (_, index) => <View key={`skeleton-filler-${index}`} style={styles.catalogCell} />)
            : null}
        </View>
      ))}
    </View>
  );
}

/**
 * One role in the catalog grid or the newness lane: the same queue, hide and
 * swipe behaviour every role card carries, composed compactly so several roles
 * share one screen instead of one tall card per row.
 */
function CatalogTile({
  job,
  presentation,
  isNew = false,
  applicationStatuses,
  queuedJobIds,
  queuingJobIds,
  onOpenRole,
  onAddToQueue,
  onHideLocally,
  onRemoveFromQueue,
}: CatalogCardProps & { job: Job; presentation: CatalogPresentation; isNew?: boolean }) {
  const lane = presentation === "lane";
  const display = presentCatalogRole(job);
  const source = sourcePresentation(job.sourceReferences);
  const timing = postingTimingPresentation(job.sourceReferences, job.firstSeenAt);
  const recencyBadge = postingRecencyBadge(isNew, timing);
  const applicationStatus = applicationStatuses?.get(job.jobId);
  const isQueued = queuedJobIds?.has(job.jobId);
  const queuing = Boolean(queuingJobIds?.has(job.jobId));
  const inQueue = isQueued ?? applicationStatus === "saved";
  const canAddToQueue = Boolean(onAddToQueue) && !queuing && (!applicationStatus || (applicationStatus === "saved" && !isQueued));
  const canHideLocally = Boolean(onHideLocally);
  const {
    handleHide,
    handleQueue,
    translateX,
    panHandlers,
    queueProgress,
    hideProgress,
    hideFade,
    hideScale,
    hideTranslateY,
  } = useCardGestures({
    queueable: canAddToQueue,
    hideable: canHideLocally,
    onQueue: () => onAddToQueue?.(job),
    onHide: () => onHideLocally?.(job),
  });
  const handleRemoveFromQueue = () => {
    if (!onRemoveFromQueue) return;
    onRemoveFromQueue(job);
  };
  return (
    <Animated.View style={[styles.catalogCell, { opacity: hideFade, transform: [{ scale: hideScale }, { translateY: hideTranslateY }] }]}>
      <View style={[styles.swipeCard, styles.catalogCellStack]}>
        {canAddToQueue || queuing ? (
          <Animated.View pointerEvents="none" style={[styles.swipeSaveAction, { opacity: queueProgress }]}>
            <Ionicons name="bookmark" size={18} color="#FFFFFF" />
            <Text style={styles.swipeSaveActionText}>{queuing ? (inQueue ? "Removing…" : "Adding…") : "Mark"}</Text>
          </Animated.View>
        ) : null}
        {canHideLocally ? (
          <Animated.View pointerEvents="none" style={[styles.swipeHideAction, { opacity: hideProgress }]}>
            <Ionicons name="eye-off-outline" size={18} color={colors.onDark} />
            <Text style={styles.swipeHideActionText}>Hide</Text>
          </Animated.View>
        ) : null}
        <Animated.View {...panHandlers} style={[styles.catalogCellStack, { transform: [{ translateX }] }]}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`${recencyBadge ? `${recencyBadge} role, ` : ""}${display.title} at ${display.company}, ${display.location}, ${display.season}, ${timing.summary}${source.primary ? `, ${source.primary}` : ""}${job.postingIdentityStatus === "unconfirmed" ? ", identity unconfirmed" : ""}${applicationStatus ? `, ${applicationStatus}` : ""}`}
            accessibilityHint={
              canAddToQueue && canHideLocally
                ? "Swipe left to add this role to the apply queue, or swipe right to hide it on this device."
                : canAddToQueue
                  ? "Swipe left to add this role to the queue and apply later."
                  : canHideLocally
                    ? "Swipe right to hide this role on this device."
                    : undefined
            }
            accessibilityActions={
              [
                ...(canAddToQueue ? [{ name: "queue", label: "Add to apply queue" }] : []),
                ...(inQueue && onRemoveFromQueue ? [{ name: "removeFromQueue", label: "Remove from queue" }] : []),
                ...(canHideLocally ? [{ name: "hide", label: "Hide on this device" }] : []),
              ]
            }
            onAccessibilityAction={(event) => {
              if (event.nativeEvent.actionName === "queue") handleQueue();
              if (event.nativeEvent.actionName === "removeFromQueue") handleRemoveFromQueue();
              if (event.nativeEvent.actionName === "hide") handleHide();
            }}
            activeOpacity={0.85}
            style={[styles.catalogTile, lane && styles.catalogTileLane]}
            onPress={() => onOpenRole(job)}
          >
            <View style={styles.catalogTileTop}>
              {job.disciplines?.length ? (
                <View style={styles.catalogTileTags}>
                  {job.disciplines.slice(0, lane ? 2 : 1).map((entry) => {
                    const style = disciplineStyleFor(entry);
                    return (
                      <View key={entry} style={[styles.disciplinePill, { backgroundColor: style.backgroundColor, borderColor: style.borderColor }]}>
                        <Text style={[styles.disciplinePillText, { color: style.color }]}>{style.label}</Text>
                      </View>
                    );
                  })}
                </View>
              ) : <View />}
              {recencyBadge ? (
                <View style={styles.catalogTileNew} accessibilityLabel={`${recencyBadge} role`}>
                  <Ionicons name="sparkles-outline" size={12} color={colors.signal} />
                  <Text style={styles.catalogTileNewText}>{recencyBadge}</Text>
                </View>
              ) : null}
            </View>
            <Text style={styles.catalogTileCompany} numberOfLines={1}>{display.company}</Text>
            <Text style={[styles.catalogTileTitle, lane && styles.catalogTileTitleLane]} numberOfLines={lane ? 2 : 3}>{display.title}</Text>
            <Text style={styles.catalogTileMeta} numberOfLines={2}>{display.location} · {display.season}</Text>
            {display.compensation ? <Text style={styles.catalogTileComp} numberOfLines={1}>{display.compensation}</Text> : null}
            {lane ? <Text style={styles.catalogTileTiming} numberOfLines={1}>{timing.summary}</Text> : null}
            {!job.open ? <Text style={styles.closedStatus}>Closed</Text> : null}
            <View style={styles.catalogTileFooter}>
              <View style={styles.catalogTileState}>
                {!inQueue && applicationStatus ? <Text style={styles.catalogTileStateText}>{applicationStatus.toUpperCase()}</Text> : null}
                {job.postingIdentityStatus === "unconfirmed" ? (
                  <Ionicons name="shield-outline" size={13} color={colors.muted} accessibilityLabel="Identity unconfirmed" />
                ) : null}
              </View>
              <View style={styles.catalogTileActions}>
                {canHideLocally ? (
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Hide on this device" onPress={handleHide} style={styles.catalogTileAction}>
                    <Ionicons name="eye-off-outline" size={16} color={colors.muted} />
                    <Text style={styles.catalogTileActionText} numberOfLines={1}>Hide</Text>
                  </TouchableOpacity>
                ) : null}
                {queuing ? (
                  <View style={styles.catalogTileAction}>
                    <Text style={styles.catalogTileActionText}>{inQueue ? "Removing…" : "Adding…"}</Text>
                  </View>
                ) : null}
                {!queuing && inQueue && onRemoveFromQueue ? (
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Remove from queue" onPress={handleRemoveFromQueue} style={[styles.catalogTileAction, styles.catalogTileActionActive]}>
                    <Ionicons name="bookmark" size={16} color={colors.signal} />
                    <Text style={styles.catalogTileActionActiveText} numberOfLines={1}>In queue</Text>
                  </TouchableOpacity>
                ) : null}
                {canAddToQueue ? (
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Add to apply queue" accessibilityHint="Adds this role to the apply queue" onPress={handleQueue} style={styles.catalogTileAction}>
                    <Ionicons name="bookmark-outline" size={16} color={colors.ink} />
                    <Text style={[styles.catalogTileActionText, styles.catalogTileActionStrong]} numberOfLines={1}>Queue</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

/**
 * An employer group with several roles. Queue and hide act on the featured role,
 * exactly as the tall group card does, so the actions mean the same thing in both.
 */
function CatalogGroupTile({
  group,
  presentation,
  status,
  applicationStatuses,
  queuedJobIds,
  queuingJobIds,
  onOpenGroup,
  onAddToQueue,
  onHideLocally,
  onRemoveFromQueue,
}: CatalogCardProps & { group: CatalogGroupRow; presentation: CatalogPresentation }) {
  const lane = presentation === "lane";
  const featuredRole = group.featuredRole;
  const featuredJob = featuredRole ? catalogRoleJob(featuredRole) : undefined;
  const applicationStatus = featuredJob ? applicationStatuses?.get(featuredJob.jobId) : undefined;
  const isQueued = featuredJob ? queuedJobIds?.has(featuredJob.jobId) : undefined;
  const queuing = Boolean(featuredJob && queuingJobIds?.has(featuredJob.jobId));
  const inQueue = isQueued ?? applicationStatus === "saved";
  const canAddToQueue = Boolean(featuredJob && onAddToQueue) && !queuing && (!applicationStatus || (applicationStatus === "saved" && !isQueued));
  const canHideLocally = Boolean(featuredJob && onHideLocally);
  const {
    handleHide,
    handleQueue,
    translateX,
    panHandlers,
    queueProgress,
    hideProgress,
    hideFade,
    hideScale,
    hideTranslateY,
  } = useCardGestures({
    queueable: canAddToQueue,
    hideable: canHideLocally,
    onQueue: () => featuredJob && onAddToQueue?.(featuredJob),
    onHide: () => featuredJob && onHideLocally?.(featuredJob),
  });
  const handleRemoveFromQueue = () => {
    if (featuredJob && onRemoveFromQueue) onRemoveFromQueue(featuredJob);
  };
  const groupCompany = boundedCatalogText(group.company, 160);
  const groupTitles = group.titles.map((title) => boundedCatalogText(title, 240)).filter(Boolean);
  const groupLocation = compactLocations(group.locations);
  const compensation = (group.compensations ?? []).filter(Boolean);
  const availability = catalogGroupAvailabilityLabel(group, status);
  const timing = featuredRole
    ? postingTimingPresentation(featuredRole.sourceReferences ?? [], featuredRole.firstSeenAt ?? featuredRole.visibleAt)
    : undefined;
  return (
    <Animated.View style={[styles.catalogCell, { opacity: hideFade, transform: [{ scale: hideScale }, { translateY: hideTranslateY }] }]}>
      <View style={[styles.swipeCard, styles.catalogCellStack]}>
        {canAddToQueue || queuing ? (
          <Animated.View pointerEvents="none" style={[styles.swipeSaveAction, { opacity: queueProgress }]}>
            <Ionicons name="bookmark" size={18} color="#FFFFFF" />
            <Text style={styles.swipeSaveActionText}>{queuing ? (inQueue ? "Removing…" : "Adding…") : "Mark"}</Text>
          </Animated.View>
        ) : null}
        {canHideLocally ? (
          <Animated.View pointerEvents="none" style={[styles.swipeHideAction, { opacity: hideProgress }]}>
            <Ionicons name="eye-off-outline" size={18} color={colors.onDark} />
            <Text style={styles.swipeHideActionText}>Hide</Text>
          </Animated.View>
        ) : null}
        <Animated.View {...panHandlers} style={[styles.catalogCellStack, { transform: [{ translateX }] }]}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`${groupCompany}, ${availability}, ${boundedCatalogText(groupTitles.join(", "), 480)}${group.unconfirmedRoleCount ? `, ${group.unconfirmedRoleCount} ${group.unconfirmedRoleCount === 1 ? "role has" : "roles have"} unconfirmed identity` : ""}`}
            accessibilityHint="Opens every role in this group"
            onPress={() => onOpenGroup(group)}
            activeOpacity={0.85}
            style={[styles.catalogTile, lane && styles.catalogTileLane]}
          >
            <View style={styles.catalogTileTop}>
              <View style={styles.catalogTileTags}>
                <View style={styles.catalogGroupCountPill}>
                  <Text style={styles.catalogGroupCountText}>{group.roleCount} roles</Text>
                </View>
                {group.disciplines?.slice(0, lane ? 2 : 1).map((entry) => {
                  const style = disciplineStyleFor(entry);
                  return (
                    <View key={entry} style={[styles.disciplinePill, { backgroundColor: style.backgroundColor, borderColor: style.borderColor }]}>
                      <Text style={[styles.disciplinePillText, { color: style.color }]}>{style.label}</Text>
                    </View>
                  );
                })}
              </View>
            </View>
            <Text style={styles.catalogTileCompany} numberOfLines={1}>{groupCompany}</Text>
            <Text style={[styles.catalogTileTitle, lane && styles.catalogTileTitleLane]} numberOfLines={lane ? 3 : 4}>{groupTitles.join(" · ")}</Text>
            <Text style={styles.catalogTileMeta} numberOfLines={2}>
              {[groupLocation, group.seasons.map(seasonLabel).join(" · ")].filter(Boolean).join("  •  ")}
            </Text>
            {compensation.length ? (
              <Text style={styles.catalogTileComp} numberOfLines={1}>
                {compensation.slice(0, 2).join(" · ")}{compensation.length > 2 ? ` +${compensation.length - 2}` : ""}
              </Text>
            ) : null}
            {lane && timing ? <Text style={styles.catalogTileTiming} numberOfLines={1}>{timing.summary}</Text> : null}
            {group.unconfirmedRoleCount ? (
              <Text style={styles.catalogTileNotice} numberOfLines={1}>
                {group.unconfirmedRoleCount} {group.unconfirmedRoleCount === 1 ? "role" : "roles"} unconfirmed
              </Text>
            ) : null}
            <View style={styles.catalogTileFooter}>
              <View style={styles.catalogTileState}>
                {inQueue ? <Text style={styles.catalogTileStateText}>In queue</Text> : null}
              </View>
              <View style={styles.catalogTileActions}>
                {canHideLocally ? (
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Hide on this device" onPress={handleHide} style={styles.catalogTileAction}>
                    <Ionicons name="eye-off-outline" size={16} color={colors.muted} />
                    <Text style={styles.catalogTileActionText} numberOfLines={1}>Hide</Text>
                  </TouchableOpacity>
                ) : null}
                {queuing ? (
                  <View style={styles.catalogTileAction}>
                    <Text style={styles.catalogTileActionText}>{inQueue ? "Removing…" : "Adding…"}</Text>
                  </View>
                ) : null}
                {!queuing && inQueue && onRemoveFromQueue ? (
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Remove from queue" onPress={handleRemoveFromQueue} style={[styles.catalogTileAction, styles.catalogTileActionActive]}>
                    <Ionicons name="bookmark" size={16} color={colors.signal} />
                    <Text style={styles.catalogTileActionActiveText} numberOfLines={1}>In queue</Text>
                  </TouchableOpacity>
                ) : null}
                {canAddToQueue ? (
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Add to apply queue" accessibilityHint="Adds this role to the apply queue" onPress={handleQueue} style={styles.catalogTileAction}>
                    <Ionicons name="bookmark-outline" size={16} color={colors.ink} />
                    <Text style={[styles.catalogTileActionText, styles.catalogTileActionStrong]} numberOfLines={1}>Queue</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

/** Dispatches a catalog row to the tile that matches its shape. */
function CatalogGroupItem({
  group,
  presentation,
  newJobIds,
  ...card
}: CatalogCardProps & { group: CatalogGroupRow; presentation: CatalogPresentation }) {
  if (catalogCardKind(group) === "role" && group.featuredRole) {
    return (
      <CatalogTile
        job={catalogRoleJob(group.featuredRole)}
        presentation={presentation}
        isNew={Boolean(newJobIds?.has(group.featuredRole.jobId))}
        newJobIds={newJobIds}
        {...card}
      />
    );
  }
  return <CatalogGroupTile group={group} presentation={presentation} newJobIds={newJobIds} {...card} />;
}

/**
 * What appeared since your last visit, in the same tiles as the grid so the lane
 * reads as the top of one catalog rather than a separate feed.
 */
function NewnessLane({
  groups,
  since,
  attentive = true,
  onOpenGroup,
  onOpenRole,
  onAddToQueue,
  onHideLocally,
  onRemoveFromQueue,
  applicationStatuses,
  queuedJobIds,
  queuingJobIds,
  newJobIds,
  status,
}: CatalogCardProps & { groups: CatalogGroupRow[]; since: string; attentive?: boolean }) {
  const { width } = useWindowDimensions();
  const motionAllowed = useContext(MotionAllowedContext);
  const laneTileWidth = width < 600 ? Math.min(300, width - 76) : 320;
  const laneStep = laneTileWidth + 12;
  const roleCount = groups.reduce((total, group) => total + group.roleCount, 0);
  const listRef = useRef<FlatList<CatalogGroupRow>>(null);
  const [cycling, setCycling] = useState(true);
  // A drag is a reader taking the wheel: hold off for a while instead of
  // yanking the lane onward under their hand.
  const heldUntil = useRef(0);
  const autoCycles = cycling && attentive && motionAllowed && groups.length > 1;
  const laneWrapRef = useRef<View>(null);
  const tweenRef = useRef(0);
  const tweening = useRef(false);
  const laneTarget = useRef(0);
  // react-native-web ignores `scrollToOffset` for a horizontal list and its
  // `behavior: 'smooth'` scroll never commits, so the web build tweens the
  // scroller's own node and native keeps the list's own animation.
  const laneScroller = () => {
    // react-native-web renders a View as its DOM node; the scroller is the one
    // descendant that overflows sideways.
    const wrap = laneWrapRef.current as unknown as HTMLElement | null;
    if (!wrap) return null;
    return Array.from(wrap.querySelectorAll<HTMLElement>("div")).find((node) => node.scrollWidth > node.clientWidth + 20) ?? null;
  };
  const scrollLaneTo = (offset: number) => {
    if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(tweenRef.current);
    laneTarget.current = offset;
    const scroller = typeof window === "undefined" ? null : laneScroller();
    if (!scroller) {
      listRef.current?.scrollToOffset({ offset, animated: true });
      return;
    }
    const from = scroller.scrollLeft;
    const started = Date.now();
    tweening.current = true;
    const step = () => {
      const progress = Math.min(1, (Date.now() - started) / 760);
      const eased = 1 - (1 - progress) ** 3;
      scroller.scrollLeft = from + (offset - from) * eased;
      if (progress < 1) {
        tweenRef.current = requestAnimationFrame(step);
        return;
      }
      tweenRef.current = 0;
      // Let the trailing scroll events from this glide land before listening again.
      setTimeout(() => { tweening.current = false; }, 200);
    };
    tweenRef.current = requestAnimationFrame(step);
  };
  /** Any scroll the glide did not cause is the reader taking the wheel. */
  const mountedAt = useRef(Date.now());
  const onLaneScroll = () => {
    // The lane settles its own layout on mount; that is not the reader moving it.
    if (tweening.current || Date.now() - mountedAt.current < 2000) return;
    const scroller = typeof window === "undefined" ? null : laneScroller();
    if (!scroller || Math.abs(scroller.scrollLeft - laneTarget.current) < 8) return;
    heldUntil.current = Date.now() + 12000;
  };
  useEffect(() => () => { if (typeof cancelAnimationFrame === "function") cancelAnimationFrame(tweenRef.current); }, []);
  /** The lane's meaningful resting offsets: one per tile, ending at the last full
   * scroll — stepping past the scrollable range would silently do nothing. */
  const laneStops = (max: number) => {
    if (max <= 0) return [0];
    const stops: number[] = [];
    for (let offset = 0; offset <= max; offset += laneStep) stops.push(offset);
    const last = stops[stops.length - 1]!;
    if (last !== max && max - last > laneStep / 2) stops.push(max);
    return stops;
  };
  useEffect(() => {
    if (!autoCycles) return;
    let stop = 0;
    const timer = setInterval(() => {
      if (Date.now() < heldUntil.current) return;
      const scroller = typeof window === "undefined" ? null : laneScroller();
      // An unmeasured lane and a lane that already fits have one resting place;
      // leave the stop where it is and try again on the next tick.
      if (!scroller) return;
      const max = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
      const stops = laneStops(max);
      if (stops.length < 2) return;
      stop = (stop + 1) % stops.length;
      scrollLaneTo(stops[stop]!);
    }, 4200);
    return () => clearInterval(timer);
  }, [autoCycles, groups.length, laneStep]);
  return (
    <View style={styles.catalogLane}>
      <View style={styles.catalogLaneHeader}>
        <View style={styles.catalogLaneHeading}>
          <Text style={styles.catalogLaneTitle}>
            {roleCount} new {roleCount === 1 ? "role" : "roles"} since {since}
          </Text>
          <Text style={styles.catalogLaneCaption}>Freshly matched your alerts</Text>
        </View>
        {groups.length > 1 ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={cycling ? "Stop the new roles from advancing" : "Let the new roles advance again"}
            aria-pressed={!cycling}
            onPress={() => setCycling((current) => !current)}
            style={styles.catalogLaneControl}
          >
            <Ionicons name={cycling ? "pause" : "play"} size={14} color={colors.muted} />
            <Text style={styles.catalogLaneControlText}>{cycling ? "Pause" : "Play"}</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      <View ref={laneWrapRef}>
      <FlatList
        ref={listRef}
        horizontal
        data={groups}
        keyExtractor={(group) => group.groupId}
        showsHorizontalScrollIndicator={false}
        snapToInterval={laneStep}
        decelerationRate="fast"
        onScrollBeginDrag={() => { heldUntil.current = Date.now() + 12000; }}
        onScroll={onLaneScroll}
        scrollEventThrottle={32}
        onScrollToIndexFailed={() => undefined}
        contentContainerStyle={styles.catalogLaneList}
        renderItem={({ item }) => (
          <View style={{ width: laneTileWidth }}>
            <CatalogGroupItem
              group={item}
              presentation="lane"
              status={status}
              newJobIds={newJobIds}
              applicationStatuses={applicationStatuses}
              queuedJobIds={queuedJobIds}
              queuingJobIds={queuingJobIds}
              onOpenGroup={onOpenGroup}
              onOpenRole={onOpenRole}
              onAddToQueue={onAddToQueue}
              onHideLocally={onHideLocally}
              onRemoveFromQueue={onRemoveFromQueue}
            />
          </View>
        )}
      />
      </View>
      {/* The lane is the top of the catalog, not the catalog: the rule keeps it
          from bleeding into the grid below. */}
      <View style={styles.catalogLaneRule} />
    </View>
  );
}

function CatalogGroupCard({
  group,
  onOpenGroup,
  onOpenRole,
  status = "open",
  onAddToQueue,
  isAddingToQueue = false,
  onHideLocally,
  applicationStatus,
  isQueued,
  onRemoveFromQueue,
}: {
  group: CatalogGroupRow;
  onOpenGroup: () => void;
  onOpenRole: (job: Job) => void;
  status?: "open" | "closed";
  onAddToQueue?: () => void;
  isAddingToQueue?: boolean;
  onHideLocally?: () => void;
  applicationStatus?: string;
  /** Explicit queue membership; defaults to saved status when omitted (guest). */
  isQueued?: boolean;
  onRemoveFromQueue?: () => void;
}) {
  const inQueue = isQueued ?? applicationStatus === "saved";
  const queueProgressLabel = inQueue ? "Removing…" : "Adding…";
  const canAddToQueue = Boolean(onAddToQueue) && !isAddingToQueue && (!applicationStatus || (applicationStatus === "saved" && !inQueue));
  const canHideLocally = Boolean(onHideLocally);
  const {
    handleHide,
    handleQueue,
    translateX,
    panHandlers,
    queueProgress,
    hideProgress,
    hideFade,
    hideScale,
    hideTranslateY,
  } = useCardGestures({ queueable: canAddToQueue, hideable: canHideLocally, onQueue: onAddToQueue, onHide: onHideLocally });
  if (catalogCardKind(group) === "role") {
    const job = catalogRoleJob(group.featuredRole);
    return <JobCard job={job} onOpen={() => onOpenRole(job)} onAddToQueue={onAddToQueue} isAddingToQueue={isAddingToQueue} onHideLocally={onHideLocally} applicationStatus={applicationStatus} isQueued={isQueued} onRemoveFromQueue={onRemoveFromQueue} />;
  }
  const label = catalogGroupAvailabilityLabel(group, status);
  const education = group.education
    .filter((item) => item.evidence !== "unspecified")
    .map((item) => item.label)
    .join(" · ");
  const featuredRole = group.featuredRole;
  const source = sourcePresentation(featuredRole?.sourceReferences ?? []);
  const postingTiming = featuredRole
    ? postingTimingPresentation(featuredRole.sourceReferences ?? [], featuredRole.firstSeenAt ?? featuredRole.visibleAt)
    : undefined;
  const compensation = (group.compensations ?? []).filter(Boolean);
  const groupCompany = boundedCatalogText(group.company, 160);
  const groupTitles = group.titles.map((title) => boundedCatalogText(title, 240)).filter(Boolean);
  const groupLocation = compactLocations(group.locations);
  return (
    <Animated.View style={{ opacity: hideFade, transform: [{ scale: hideScale }, { translateY: hideTranslateY }] }}>
      <View style={styles.swipeCard}>
        {canAddToQueue || isAddingToQueue ? (
          <Animated.View pointerEvents="none" style={[styles.swipeSaveAction, { opacity: queueProgress }]}>
            <Ionicons name="bookmark" size={20} color="#FFFFFF" />
            <Text style={styles.swipeSaveActionText}>{isAddingToQueue ? queueProgressLabel : "Mark"}</Text>
          </Animated.View>
        ) : null}
        {canHideLocally ? (
          <Animated.View pointerEvents="none" style={[styles.swipeHideAction, { opacity: hideProgress }]}>
            <Ionicons name="eye-off-outline" size={20} color={colors.onDark} />
            <Text style={styles.swipeHideActionText}>Hide</Text>
          </Animated.View>
        ) : null}
        <Animated.View {...panHandlers} style={{ transform: [{ translateX }] }}>
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`${groupCompany}, ${label}, ${boundedCatalogText(groupTitles.join(", "), 480)}${group.unconfirmedRoleCount ? `, ${group.unconfirmedRoleCount} ${group.unconfirmedRoleCount === 1 ? "role has" : "roles have"} unconfirmed identity` : ""}`}
            accessibilityHint="Opens every role in this group"
            onPress={onOpenGroup}
            style={styles.catalogGroupCard}
          >
            <View style={styles.catalogGroupTopline}>
              <View style={styles.jobCompanyLeft}>
                <Text style={styles.company} numberOfLines={1}>{groupCompany}</Text>
                <Text style={styles.catalogGroupCount}>{label}</Text>
              </View>
              {group.disciplines?.length ? (
                <View style={styles.catalogGroupTopTags}>
                  {group.disciplines.slice(0, 2).map((d) => {
                    const s = disciplineStyleFor(d);
                    return (
                      <View key={d} style={[styles.disciplinePill, { backgroundColor: s.backgroundColor, borderColor: s.borderColor }]}>
                        <Text style={[styles.disciplinePillText, { color: s.color }]}>{s.label}</Text>
                      </View>
                    );
                  })}
                </View>
              ) : null}
            </View>
            <Text style={styles.catalogGroupTitle} numberOfLines={group.roleCount === 1 ? 2 : 3}>
              {groupTitles.join(" · ")}
            </Text>
            <Text style={styles.catalogGroupMeta} numberOfLines={3}>
              {[groupLocation, group.seasons.map(seasonLabel).join(" · ")].filter(Boolean).join("  •  ")}
              {compensation.length ? <Text style={styles.payInline}> · {compensation.slice(0, 2).join(" · ")}{compensation.length > 2 ? ` + ${compensation.length - 2} more` : ""}</Text> : null}
            </Text>
            {featuredRole ? <JobSource source={source} /> : null}
            {postingTiming ? <Text style={styles.postingTiming}>{postingTiming.summary}</Text> : null}
            {education ? <Text style={styles.catalogGroupEducation} numberOfLines={2}>{education}</Text> : null}
            {group.unconfirmedRoleCount ? (
              <Text style={styles.catalogGroupIdentity} accessibilityLabel={`${group.unconfirmedRoleCount} ${group.unconfirmedRoleCount === 1 ? "role" : "roles"}: identity unconfirmed`}>
                {group.unconfirmedRoleCount} {group.unconfirmedRoleCount === 1 ? "role" : "roles"}: identity unconfirmed
              </Text>
            ) : null}
            <View style={styles.catalogGroupFooterLeft}>
              <View style={styles.jobCardActionCompact}>
                <Text style={styles.jobCardActionText}>View roles</Text>
                <Ionicons name="chevron-forward" size={17} color={colors.signal} />
              </View>
              <View style={styles.jobCardBottomActions}>
                {canHideLocally ? (
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Hide on this device" onPress={handleHide} style={styles.webHideButtonCompact}>
                    <Ionicons name="eye-off-outline" size={14} color={colors.muted} />
                    <Text style={styles.webHideButtonText}>Hide</Text>
                  </TouchableOpacity>
                ) : null}
                {!isAddingToQueue && inQueue && onRemoveFromQueue ? (
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Remove from queue" onPress={() => { if (!onRemoveFromQueue) return; onRemoveFromQueue(); }} style={styles.webInQueueButtonCompact}>
                    <Ionicons name="bookmark" size={14} color={colors.signal} />
                    <Text style={styles.webInQueueButtonText}>In queue</Text>
                  </TouchableOpacity>
                ) : null}
                {isAddingToQueue ? (
                  <View style={styles.webQueueButtonCompact}>
                    <Text style={styles.webQueueButtonText}>{queueProgressLabel}</Text>
                  </View>
                ) : null}
                {canAddToQueue ? (
                  <TouchableOpacity accessibilityRole="button" accessibilityLabel="Add to apply queue" accessibilityHint="Adds this role to the apply queue" onPress={handleQueue} style={styles.webQueueButtonCompact}>
                    <Ionicons name="bookmark" size={14} color={colors.ink} />
                    <Text style={styles.webQueueButtonText}>Queue</Text>
                  </TouchableOpacity>
                ) : null}
              </View>
            </View>
          </TouchableOpacity>
        </Animated.View>
      </View>
    </Animated.View>
  );
}

function CatalogGroupSheet({
  groupId,
  details,
  loading,
  error,
  onDismiss,
  onRetry,
  onOpenRole,
}: {
  groupId?: string;
  details?: CatalogGroupDetails;
  loading: boolean;
  error?: string;
  onDismiss: () => void;
  onRetry: () => void;
  onOpenRole: (job: Job) => void;
}) {
  const visible = Boolean(groupId);
  const sheetOffset = useSheetEntranceOffset(visible);
  return (
    <Modal visible={visible} transparent animationType="none" onRequestClose={onDismiss}>
      <View style={styles.sheetOverlay}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close role group" style={styles.sheetDismissArea} onPress={onDismiss} />
        <Animated.View style={[styles.catalogGroupSheet, { transform: [{ translateY: sheetOffset }] }]}>
          <View style={styles.sheetHandle} />
          {loading ? (
            <CatalogGroupLoadingSkeleton />
          ) : error ? (
            <View style={styles.catalogGroupErrorState}>
              <Text accessibilityRole="alert" style={styles.catalogGroupError}>{error}</Text>
              <ActionButton label="Try again" onPress={onRetry} />
            </View>
          ) : details ? (
            <>
              <View style={styles.catalogGroupSheetHeader}>
                <Text style={styles.sheetTitle}>{boundedCatalogText(details.group.company, 160)}</Text>
                <Text style={styles.sheetCompany}>
                  {details.group.roleCount} {details.roles.every((role) => role.open) ? "open " : details.roles.every((role) => !role.open) ? "closed " : ""}role{details.group.roleCount === 1 ? "" : "s"}
                </Text>
                {details.group.unconfirmedRoleCount ? (
                  <Text style={styles.sheetTrustSecondary}>
                    {details.group.unconfirmedRoleCount} {details.group.unconfirmedRoleCount === 1 ? "role" : "roles"}: identity unconfirmed
                  </Text>
                ) : null}
                {details.group.education.map((item) => item.label).filter(Boolean).map((label) => (
                  <Text key={label} style={styles.sheetDetail}>{label}</Text>
                ))}
              </View>
              <FlatList
                data={details.roles}
                keyExtractor={(role) => role.jobId}
                contentContainerStyle={styles.catalogGroupRoles}
                renderItem={({ item }) => (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`${boundedCatalogText(item.title, 240)}, ${compactLocations(item.locations, item.location)}${item.postingIdentityStatus === "unconfirmed" ? ", identity unconfirmed" : ""}`}
                    onPress={() => onOpenRole(catalogRoleJob(item))}
                    style={styles.catalogGroupRole}
                  >
                    <View style={styles.catalogGroupRoleCopy}>
                      <Text style={styles.catalogGroupRoleTitle} numberOfLines={2}>{boundedCatalogText(item.title, 240)}</Text>
                      <Text style={styles.catalogGroupRoleMeta} numberOfLines={2}>{compactLocations(item.locations, item.location)} · {seasonLabel(item.season)}</Text>
                      {item.postingIdentityStatus === "unconfirmed" ? <IdentityTrustLabel /> : null}
                      {presentCatalogRole(item).compensation ? <Text style={styles.catalogGroupRolePay} numberOfLines={2}>{presentCatalogRole(item).compensation}</Text> : null}
                    </View>
                    <Ionicons name="chevron-forward" size={18} color={colors.signal} />
                  </TouchableOpacity>
                )}
              />
            </>
          ) : null}
        </Animated.View>
      </View>
    </Modal>
  );
}

function CatalogGroupLoadingSkeleton() {
  return (
    <View accessibilityRole="progressbar" accessibilityLabel="Loading grouped roles" style={styles.catalogGroupLoading}>
      <View style={styles.catalogGroupSkeletonHeader}>
        <Skeleton width={168} height={20} />
        <View style={styles.skeletonGap8} />
        <Skeleton width={92} height={13} />
      </View>
      <View style={styles.catalogGroupRoles}>
        {[0, 1].map((index) => (
          <View key={index} style={styles.catalogGroupRole}>
            <View style={styles.catalogGroupRoleCopy}>
              <Skeleton width={232} height={16} />
              <View style={styles.skeletonGap8} />
              <Skeleton width={148} height={12} />
            </View>
            <Skeleton width={18} height={18} />
          </View>
        ))}
      </View>
    </View>
  );
}

function NewRoleCard({
  job,
  onOpen,
  applicationStatus,
  isQueued,
  index,
  onAddToQueue,
  isAddingToQueue,
  onHideLocally,
  onRemoveFromQueue,
}: {
  job: Job;
  onOpen: () => void;
  applicationStatus?: string;
  isQueued?: boolean;
  index: number;
  onAddToQueue?: () => void;
  isAddingToQueue?: boolean;
  onHideLocally?: () => void;
  onRemoveFromQueue?: () => void;
}) {
  const opacity = useRef(new Animated.Value(1)).current;
  const lift = useRef(new Animated.Value(0)).current;
  const glow = useRef(new Animated.Value(0)).current;
  const motionAllowed = useContext(MotionAllowedContext);

  useEffect(() => {
    if (!motionAllowed) {
      opacity.setValue(1);
      lift.setValue(0);
      glow.setValue(0);
      return;
    }
    opacity.setValue(0);
    lift.setValue(8);
    glow.setValue(0);
    const animation = Animated.sequence([
      Animated.delay(Math.min(index, 4) * 80),
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 220, useNativeDriver: true }),
        Animated.spring(lift, { toValue: 0, friction: 9, tension: 100, useNativeDriver: true }),
        Animated.sequence([
          Animated.timing(glow, { toValue: 0.18, duration: 160, useNativeDriver: true }),
          Animated.timing(glow, { toValue: 0, duration: 420, useNativeDriver: true }),
        ]),
      ]),
    ]);
    animation.start();
    return () => animation.stop();
  }, [glow, index, lift, motionAllowed, opacity]);
  return (
    <Animated.View style={{ opacity, transform: [{ translateY: lift }] }}>
      <JobCard
        job={job}
        onOpen={onOpen}
        applicationStatus={applicationStatus}
        isQueued={isQueued}
        isNew
        onAddToQueue={onAddToQueue}
        isAddingToQueue={isAddingToQueue}
        onHideLocally={onHideLocally}
        onRemoveFromQueue={onRemoveFromQueue}
      />
      <Animated.View pointerEvents="none" style={[styles.newRoleGlow, { opacity: glow }]} />
    </Animated.View>
  );
}

function JobDetailSheet({
  job,
  signedIn,
  matchedReasons = [],
  exclusionsApplied = false,
  routeState = "idle",
  onDismiss,
  onModalDismissed = () => undefined,
  onRetry = () => undefined,
  onApply,
  onOpenListing,
  onAddToQueue,
  isAddingToQueue = false,
  applicationStatus,
  isQueued,
  onHideLocally,
  onRemoveFromQueue,
}: {
  job: Job | null;
  signedIn: boolean;
  matchedReasons?: FilterMatchReason[];
  exclusionsApplied?: boolean;
  routeState?: JobRouteState;
  onDismiss: () => void;
  onModalDismissed?: () => void;
  onRetry?: () => void;
  onApply: (job: Job) => void;
  onOpenListing: (job: Job) => void;
  onAddToQueue?: (job: Job) => void;
  isAddingToQueue?: boolean;
  applicationStatus?: string;
  isQueued?: boolean;
  onHideLocally?: (job: Job) => void;
  onRemoveFromQueue?: (job: Job) => void;
}) {
  const displayedJob = useRef<Job | null>(null);
  const pendingAction = useRef<{ job: Job; kind: "apply" | "listing" } | null>(null);
  const [handoffPending, setHandoffPending] = useState(false);
  const presentation = jobDetailPresentation(Boolean(job), routeState);
  const visible = presentation.visible;
  const roleSheet = useRoleSheetTransition(visible, onDismiss);

  if (job) displayedJob.current = job;

  const role = job ?? displayedJob.current;
  const roleDisplay = role ? presentCatalogRole(role) : undefined;
  const details = [roleDisplay?.location, roleDisplay?.season]
    .filter(Boolean)
    .join(" · ");
  const actionLabel = !role?.open
    ? "View official listing"
    : signedIn
      ? "Apply on official site"
      : "Open official application";
  const greenhouseQuickApply = role ? hasGreenhouseQuickApply(role.applyUrl) : false;
  const source = sourcePresentation(role?.sourceReferences ?? []);
  const postingTiming = role
    ? postingTimingPresentation(role.sourceReferences, role.firstSeenAt)
    : undefined;
  const closedListingUrl = role && !role.open ? validatedOfficialUrl(role) : undefined;
  const inQueue = isQueued ?? applicationStatus === "saved";
  const canAddToQueue = Boolean(role && onAddToQueue && !isAddingToQueue && (!applicationStatus || (applicationStatus === "saved" && !inQueue)));
  return (
    <Modal
      animationType="none"
      transparent
      visible={roleSheet.modalVisible}
      onRequestClose={roleSheet.dismiss}
      onDismiss={() => {
        const action = pendingAction.current;
        pendingAction.current = null;
        displayedJob.current = null;
        setHandoffPending(false);
        if (action) {
          if (action.kind === "apply") onApply(action.job);
          else onOpenListing(action.job);
        }
        onModalDismissed();
      }}
      statusBarTranslucent
    >
      <Animated.View style={[styles.sheetOverlay, { opacity: roleSheet.dimOpacity }]}>
        <TouchableOpacity
          accessibilityRole="button"
          accessibilityLabel="Close role details"
          style={styles.sheetDismissArea}
          onPress={roleSheet.dismiss}
        />
        <Animated.View
          accessibilityViewIsModal
          style={[styles.jobSheet, { transform: [{ translateY: roleSheet.sheetOffset }] }]}
        >
          <View style={styles.sheetHandle} />
          {presentation.content === "route" ? (
            <JobRouteStatusContent state={routeState} onDismiss={roleSheet.dismiss} onRetry={onRetry} />
          ) : role ? (
            <ScrollView showsVerticalScrollIndicator={false} contentContainerStyle={styles.sheetContent}>
              <Text style={styles.sheetEyebrow}>{role.open ? "Role details" : "Closed role"}</Text>
              <Text style={styles.sheetTitle}>{roleDisplay?.title}</Text>
              <Text style={styles.sheetCompany}>{roleDisplay?.company}</Text>
              {role.disciplines?.length ? (
                <View style={[styles.jobCardMidPills, { marginTop: 10 }]}>
                  {role.disciplines.slice(0, 4).map((d) => {
                    const s = disciplineStyleFor(d);
                    return (
                      <View key={d} style={[styles.disciplinePill, { backgroundColor: s.backgroundColor, borderColor: s.borderColor }]}>
                        <Text style={[styles.disciplinePillText, { color: s.color }]}>{s.label}</Text>
                      </View>
                    );
                  })}
                </View>
              ) : null}
              <Text style={styles.sheetDetail}>{details}</Text>
              {roleDisplay?.compensation ? (
                <View style={styles.jobCardMidPills}>
                  <Text style={styles.pay} numberOfLines={2}>{roleDisplay.compensation}</Text>
                </View>
              ) : null}
              {housingLabels(role.housing).map((housing, index) => (
                <View key={`${housing.label}-${index}`} style={styles.sheetTrustBlock}>
                  <Text style={styles.sheetTrustPrimary}>{housing.label}</Text>
                  {housing.detail ? <Text style={styles.sheetTrustSecondary}>{housing.detail}</Text> : null}
                </View>
              ))}
              <View style={styles.sheetTrustBlock}>
                <Text style={styles.sheetTrustPrimary}>{source.primary}</Text>
                {source.corroboration ? <Text style={styles.sheetTrustSecondary}>{source.corroboration}</Text> : null}
                {postingTiming ? <Text style={styles.sheetTrustSecondary}>{postingTiming.detail}</Text> : null}
                <Text style={styles.sheetTrustSecondary}>{freshnessLabel(role.lastSeenAt)}</Text>
              </View>
              {role.postingIdentityStatus === "unconfirmed" ? (
                <View style={styles.sheetIdentityNotice} accessibilityLabel="Identity unconfirmed. We verified the employer and application page, but have not yet matched this listing to reviewed exact posting evidence. It may later be combined with another listing.">
                  <Ionicons name="shield-outline" size={17} color={colors.signal} />
                  <Text style={styles.sheetIdentityNoticeText}>
                    We verified the employer and application page, but have not yet matched this listing to reviewed exact posting evidence. It may later be combined with another listing.
                  </Text>
                </View>
              ) : null}
              {matchedReasons.length ? (
                <View style={styles.sheetMatchBlock} accessibilityLabel={`Matched filters: ${matchedReasons.map((reason) => reason.label).join(", ")}${exclusionsApplied ? ". Your exclusions were also applied." : ""}`}>
                  <Text style={styles.sheetMatchTitle}>Why you received this alert</Text>
                  <Text style={styles.sheetMatchText}>{matchedReasons.map((reason) => reason.label).join(" · ")}</Text>
                  {exclusionsApplied ? <Text style={styles.sheetMatchHelper}>Your exclusions were also applied.</Text> : null}
                </View>
              ) : null}
              {!role.open ? (
                <View style={styles.sheetClosedNotice}>
                  <Text style={styles.sheetClosedText}>Applications for this role are closed.</Text>
                </View>
              ) : null}
              <View style={styles.sheetActions}>
                {role.open ? (
                  <ApplyNowButton
                    disabled={handoffPending}
                    label={greenhouseQuickApply ? "Open Greenhouse Quick Apply" : actionLabel}
                    hint={
                      greenhouseQuickApply
                        ? "Opens the official Greenhouse application. If this employer enables Quick Apply, MyGreenhouse can fill details you have saved there."
                        : "Opens the official employer form."
                    }
                    onPress={() => startRoleAction("apply")}
                  />
                ) : null}
                {isAddingToQueue ? (
                  <View style={styles.sheetSaveBar}>
                    <Text style={styles.sheetSaveBarText}>{inQueue ? "Removing…" : "Adding…"}</Text>
                  </View>
                ) : canAddToQueue ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Add to apply queue"
                    accessibilityHint="Adds this role to the apply queue"
                    onPress={() => {
                      if (role && onAddToQueue) onAddToQueue(role);
                      roleSheet.dismiss();
                    }}
                    style={styles.sheetSaveBar}
                  >
                    <Ionicons name="bookmark" size={18} color={colors.ink} />
                    <Text style={styles.sheetSaveBarText}>Add to apply queue</Text>
                  </TouchableOpacity>
                ) : inQueue && onRemoveFromQueue && role ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Remove from queue"
                    onPress={() => { onRemoveFromQueue(role); roleSheet.dismiss(); }}
                    style={styles.sheetInQueueBar}
                  >
                    <Ionicons name="bookmark" size={18} color={colors.signal} />
                    <Text style={styles.sheetInQueueBarText}>In queue</Text>
                  </TouchableOpacity>
                ) : null}
                {onHideLocally && role ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel="Hide on this device"
                    onPress={() => { onHideLocally(role); roleSheet.dismiss(); }}
                    style={styles.sheetHideBar}
                  >
                    <Ionicons name="eye-off-outline" size={18} color={colors.muted} />
                    <Text style={styles.sheetHideBarText}>Hide</Text>
                  </TouchableOpacity>
                ) : null}
                <ActionButton label="Not now" variant="secondary" onPress={roleSheet.dismiss} />
              </View>
              <Text style={styles.sheetHelper}>
                {!role.open
                  ? closedListingUrl
                    ? "The last validated official listing remains available for reference."
                    : "The official listing link is no longer verified, so it has been removed."
                  : greenhouseQuickApply
                  ? "If this employer enables Quick Apply, MyGreenhouse can fill the details you have saved there. Review every answer before submitting."
                  : signedIn
                  ? "Queued roles are saved automatically. Apply next opens each employer form in turn."
                  : "You’ll complete the employer’s application in your browser."}
              </Text>
            </ScrollView>
          ) : null}
        </Animated.View>
      </Animated.View>
    </Modal>
  );

  function startRoleAction(kind: "apply" | "listing") {
    if (!role || pendingAction.current) return;
    pendingAction.current = { job: role, kind };
    setHandoffPending(true);
    roleSheet.dismiss();
    // Android does not fire Modal.onDismiss. Let its modal teardown finish
    // before opening the Custom Tab instead.
    if (Platform.OS !== "ios") {
      InteractionManager.runAfterInteractions(() => {
        const action = pendingAction.current;
        pendingAction.current = null;
        displayedJob.current = null;
        setHandoffPending(false);
        if (action) {
          if (action.kind === "apply") onApply(action.job);
          else onOpenListing(action.job);
        }
      });
    }
  }
}

function ApplyNowButton({
  onPress,
  disabled = false,
  label = "Open official application",
  hint = "Opens the official employer form",
}: {
  onPress: () => void;
  disabled?: boolean;
  label?: string;
  hint?: string;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={hint}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={[styles.applyNowButton, disabled && styles.actionButtonDisabled]}
    >
      <Text style={styles.applyNowTitle}>{label}</Text>
      <Ionicons name="open-outline" size={19} color={colors.onDark} style={styles.applyNowArrow} />
    </TouchableOpacity>
  );
}

function JobRouteStatusContent({
  state,
  onDismiss,
  onRetry,
}: {
  state: JobRouteState;
  onDismiss: () => void;
  onRetry: () => void;
}) {
  if (state === "idle") return null;
  const loading = state === "loading";
  const missing = state === "missing";
  return (
    <View style={styles.sheetContent}>
      {loading ? (
        <View accessibilityRole="progressbar" accessibilityLabel="Loading role details">
          <Text style={styles.sheetEyebrow}>Role details</Text>
          <Skeleton width={250} height={24} />
          <View style={styles.skeletonGap12} />
          <Skeleton width={180} />
          <View style={styles.skeletonGap8} />
          <Skeleton width={220} />
        </View>
      ) : (
        <>
          <Text style={styles.sheetEyebrow}>{missing ? "Role unavailable" : "Couldn’t load role"}</Text>
          <Text style={styles.sheetTitle}>{missing ? "This role is no longer available." : "Check your connection and try again."}</Text>
          <Text style={styles.sheetHelper}>{missing ? "It may have been removed from the catalog." : "Your alert and saved filters are unchanged."}</Text>
          <View style={styles.sheetActions}>
            {!missing ? <ActionButton label="Try again" onPress={onRetry} /> : null}
            <ActionButton label="Back to roles" variant="secondary" onPress={onDismiss} />
          </View>
        </>
      )}
      </View>
  );
}

function EmployerCategoryFilter({
  selected,
  onChange,
}: {
  selected: EmployerCategory | "all";
  onChange: (value: EmployerCategory | "all") => void;
}) {
  const options: Array<EmployerCategory | "all"> = ["all", "faang", "startup", "normal"];
  return (
    <View style={styles.companyFilter} accessibilityRole="radiogroup" accessibilityLabel="Company type">
      {options.map((option) => (
        <TouchableOpacity
          key={option}
          accessibilityRole="radio"
          aria-checked={selected === option}
          style={[styles.chip, selected === option && styles.chipOn]}
          onPress={() => onChange(option)}
        >
          <Text style={[styles.chipLabel, selected === option && styles.chipLabelOn]}>
            {option === "all" ? "All" : employerCategoryLabels[option]}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function JobStatusFilter({
  status,
  onChange,
}: {
  status: "open" | "closed";
  onChange: (value: "open" | "closed") => void;
}) {
  return (
    <View style={styles.companyFilter} accessibilityRole="radiogroup" accessibilityLabel="Availability">
      {(["open", "closed"] as const).map((option) => (
        <TouchableOpacity
          key={option}
          accessibilityRole="radio"
          aria-checked={status === option}
          style={[styles.chip, status === option && styles.chipOn]}
          onPress={() => onChange(option)}
        >
          <Text style={[styles.chipLabel, status === option && styles.chipLabelOn]}>
            {option === "open" ? "Open" : "Closed"}
          </Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function RequirementFilter({
  hideUsCitizenshipRequired,
  hideAdvancedDegreeRequired,
  onHideUsCitizenshipRequiredChange,
  onHideAdvancedDegreeRequiredChange,
}: {
  hideUsCitizenshipRequired: boolean;
  hideAdvancedDegreeRequired: boolean;
  onHideUsCitizenshipRequiredChange: (value: boolean) => void;
  onHideAdvancedDegreeRequiredChange: (value: boolean) => void;
}) {
  const options = [
    { key: "citizenship", label: "Hide U.S. citizenship", selected: hideUsCitizenshipRequired, onPress: () => onHideUsCitizenshipRequiredChange(!hideUsCitizenshipRequired) },
    { key: "advanced-degree", label: "Hide advanced degree", selected: hideAdvancedDegreeRequired, onPress: () => onHideAdvancedDegreeRequiredChange(!hideAdvancedDegreeRequired) },
  ];
  return (
    <View style={styles.companyFilter}>
      {options.map((option) => (
        <TouchableOpacity
          key={option.key}
          accessibilityRole="checkbox"
          aria-checked={option.selected}
          style={[styles.chip, option.selected && styles.chipOn]}
          onPress={option.onPress}
        >
          <Text style={[styles.chipLabel, option.selected && styles.chipLabelOn]}>{option.label}</Text>
        </TouchableOpacity>
      ))}
    </View>
  );
}

function toggleChipValue(selected: string[], value: string): string[] {
  return selected.includes(value) ? selected.filter((item) => item !== value) : [...selected, value];
}

function MultiChipFilter({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: ChipOption[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  return (
    <View style={styles.companyFilter} accessibilityLabel={label}>
      {options.map((option) => {
        const active = selected.includes(option.value);
        return (
          <TouchableOpacity
            key={option.value}
            accessibilityRole="checkbox"
            accessibilityLabel={`Filter ${option.label}`}
            aria-checked={active}
            style={[styles.chip, active && styles.chipOn]}
            onPress={() => onChange(toggleChipValue(selected, option.value))}
          >
            <Text style={[styles.chipLabel, active && styles.chipLabelOn]}>{option.label}</Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function FilterBar({
  activeCount,
  onOpen,
}: {
  activeCount: number;
  onOpen: () => void;
}) {
  return (
    <View style={styles.filterRegion}>
      <View style={styles.filterBar}>
        <TouchableOpacity
          accessibilityRole="button"
          onPress={onOpen}
          style={styles.filterToggle}
        >
          <Text style={styles.filterToggleText}>
            {activeCount ? `Filters · ${activeCount}` : "Filter roles"}
          </Text>
          <Text style={styles.filterToggleGlyph}>+</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}
function QueuePillButton({
  count,
  onPress,
  expanded = false,
}: {
  count: number;
  onPress: () => void;
  expanded?: boolean;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityLabel={count > 0 ? `Open apply queue, ${count} ${count === 1 ? "role" : "roles"}` : "Open apply queue"}
      onPress={onPress}
      style={styles.queuePill}
    >
      <Ionicons name="albums-outline" size={18} color={colors.signal} />
      <Text style={styles.queuePillText}>Queue</Text>
      {count > 0 ? <Text style={styles.queuePillCount}>{count}</Text> : null}
      <Ionicons name={expanded ? "chevron-up" : "chevron-down"} size={14} color={colors.muted} />
    </TouchableOpacity>
  );
}
function QueueBulkButtons({
  available,
  onOpenFirst,
  onBulkOpen,
  shortcutMode = "none",
}: {
  available: Array<{ jobId: string; applyUrl: string }>;
  onOpenFirst: () => void;
  onBulkOpen: (targets: Array<{ jobId: string; applyUrl: string }>) => void;
  shortcutMode?: "all" | "next" | "none";
}) {
  if (Platform.OS !== "web" || available.length === 0) return null;
  const half = Math.max(1, Math.ceil(available.length / 2));
  const options = [
    { label: "Next", count: 1, onPress: onOpenFirst, shortcut: "N" },
    ...(available.length >= 5 ? [{ label: "5", count: 5, onPress: () => onBulkOpen(selectBulkTargets(available, 5)), shortcut: "5" }] : []),
    ...(available.length >= 10 ? [{ label: "10", count: 10, onPress: () => onBulkOpen(selectBulkTargets(available, 10)), shortcut: "T" }] : []),
    ...(available.length >= 2 ? [
      { label: "Half", count: half, onPress: () => onBulkOpen(selectBulkTargets(available, "half")), shortcut: "H" },
      { label: "All", count: available.length, onPress: () => onBulkOpen(selectBulkTargets(available, "all")), shortcut: "A" },
    ] : []),
  ];
  return (
    <View style={styles.queueBulkBlock}>
      <Text style={styles.queueBulkLabel}>Open applications</Text>
      <View style={styles.queueBulkRow}>
        {options.map((option) => (
          <TouchableOpacity
            key={option.label}
            accessibilityRole="button"
            accessibilityLabel={`Open ${option.count} ${option.count === 1 ? "application" : "applications"}`}
            accessibilityHint={shortcutMode === "all" || (shortcutMode === "next" && option.label === "Next") ? `Keyboard shortcut: ${option.shortcut}` : undefined}
            onPress={option.onPress}
            style={styles.queueBulkButton}
          >
            <Text style={styles.queueBulkButtonLabel}>{option.label}</Text>
            {shortcutMode === "all" || (shortcutMode === "next" && option.label === "Next") ? <Text style={styles.keyboardShortcut}>{option.shortcut}</Text> : null}
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.queueBulkHint}>{available.length === 1 ? "Open the remaining application." : `Half opens ${half}; all opens ${available.length}.`} Each application opens in a new window.</Text>
    </View>
  );
}
const QUEUE_PANEL_MAX_ROWS = 6;
function QueuePanel({
  queue,
  jobs,
  onOpenQueuedRole,
  onBulkOpenQueue,
  onViewAll,
  onCollapse,
  maxRows = QUEUE_PANEL_MAX_ROWS,
}: {
  queue: Application[];
  jobs: Job[];
  onOpenQueuedRole?: (target: { jobId: string; applyUrl: string }) => void;
  onBulkOpenQueue?: (targets: Array<{ jobId: string; applyUrl: string }>) => void;
  onViewAll?: () => void;
  onCollapse?: () => void;
  maxRows?: number;
}) {
  const availableTargets = queue
    .map((item) => queueEntryTarget(item, jobs))
    .filter((target): target is { jobId: string; applyUrl: string } => target !== undefined);
  const visible = queue.slice(0, maxRows);
  const hidden = queue.length - visible.length;
  return (
    <View style={styles.queuePanel}>
      <View style={styles.queuePanelHeader}>
        <View style={styles.queuePanelHeading}>
          <View style={styles.queuePanelIcon}>
            <Ionicons name="albums-outline" size={20} color={colors.signal} />
          </View>
          <View>
            <Text style={styles.queuePanelTitle}>Apply queue</Text>
            <Text style={styles.queuePanelSubtitle}>{queue.length} {queue.length === 1 ? "role" : "roles"} ready</Text>
          </View>
        </View>
        {onCollapse ? (
          <TouchableOpacity
            accessibilityRole="button"
            accessibilityLabel={`Collapse queue list, ${queue.length} ${queue.length === 1 ? "role" : "roles"}`}
            onPress={onCollapse}
            style={styles.queuePanelCollapse}
          >
            <Ionicons name="chevron-up" size={18} color={colors.muted} />
          </TouchableOpacity>
        ) : null}
      </View>
      {queue.length === 0 ? (
        <View style={styles.queuePanelEmpty}>
          <Ionicons name="checkmark-circle-outline" size={22} color={colors.success} />
          <Text style={styles.queuePanelEmptyText}>Your queue is clear. Mark a role to keep it within reach.</Text>
        </View>
      ) : (
        <View style={styles.queuePanelList}>
          {onBulkOpenQueue ? (
            <QueueBulkButtons
              available={availableTargets}
              onOpenFirst={() => { const [first] = availableTargets; if (first) onOpenQueuedRole?.(first); }}
              onBulkOpen={onBulkOpenQueue}
              shortcutMode="all"
            />
          ) : null}
          {visible.map((item, index) => {
            const job = resolveApplicationJob(item, jobs);
            const target = queueEntryTarget(item, jobs);
            return (
              <View key={item.applicationId} style={styles.queueSheetRow}>
                <View style={styles.queueSheetCopy}>
                  <View style={styles.queueSheetPositionBadge}>
                    <Text style={styles.queueSheetPosition}>{index + 1}</Text>
                  </View>
                  <View style={styles.queueSheetText}>
                    <Text style={styles.queueRowTitle} numberOfLines={1}>{job?.title ?? "Saved role"}</Text>
                    <Text style={styles.muted} numberOfLines={1}>{job?.company ?? ""}</Text>
                  </View>
                </View>
                {target && onOpenQueuedRole ? (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`Open application for ${job?.title ?? "saved role"}${job?.company ? ` at ${job.company}` : ""}`}
                    onPress={() => onOpenQueuedRole(target)}
                    style={styles.queueOpenButton}
                  >
                    <Text style={styles.queueOpenButtonText}>Open</Text>
                    <Ionicons name="open-outline" size={15} color={colors.signal} />
                  </TouchableOpacity>
                ) : !target ? (
                  <Text style={styles.muted}>Unavailable</Text>
                ) : null}
              </View>
            );
          })}
          {hidden > 0 && onViewAll ? (
            <TouchableOpacity accessibilityRole="button" accessibilityLabel={`View all ${queue.length} queued roles`} onPress={onViewAll} style={styles.queuePanelMoreButton}>
              <Text style={styles.queuePanelMore}>View all {queue.length}</Text>
              <Ionicons name="arrow-forward" size={16} color={colors.signal} />
            </TouchableOpacity>
          ) : null}
        </View>
      )}
    </View>
  );
}

function FilterSheet({
  visible,
  filters,
  onFiltersChange,
  onClose,
}: {
  visible: boolean;
  filters: CatalogFilterValues;
  onFiltersChange: (next: CatalogFilterValues) => void;
  onClose: () => void;
}) {
  const set = (patch: Partial<CatalogFilterValues>) => onFiltersChange({ ...filters, ...patch });
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <View style={styles.filterSheetOverlay}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close filters" style={styles.sheetDismissArea} onPress={onClose} />
        <View style={styles.filterSheet}>
          <Text style={styles.sheetTitle}>Filter roles</Text>
          <ScrollView style={styles.filterSheetScroll} contentContainerStyle={styles.filterSheetContent}>
            <Text style={styles.filterLabel}>Role focus</Text>
            <MultiChipFilter label="Role focus" options={disciplineChipOptions} selected={filters.disciplines} onChange={(disciplines) => set({ disciplines })} />
            <Text style={styles.filterLabel}>Season</Text>
            <MultiChipFilter label="Season" options={seasonFilterOptions} selected={filters.seasons} onChange={(seasons) => set({ seasons })} />
            <Text style={styles.filterLabel}>Work mode</Text>
            <MultiChipFilter label="Work mode" options={workModeFilterOptions} selected={filters.workModes} onChange={(workModes) => set({ workModes })} />
            <Text style={styles.filterLabel}>Education</Text>
            <MultiChipFilter label="Education" options={educationFilterOptions} selected={filters.educationLevels} onChange={(educationLevels) => set({ educationLevels })} />
            <Text style={styles.filterLabel}>Pay</Text>
            <View style={styles.companyFilter}>
              <TouchableOpacity
                accessibilityRole="checkbox"
                accessibilityLabel="Only roles with pay listed"
                aria-checked={filters.hasCompensation}
                style={[styles.chip, filters.hasCompensation && styles.chipOn]}
                onPress={() => set({ hasCompensation: !filters.hasCompensation })}
              >
                <Text style={[styles.chipLabel, filters.hasCompensation && styles.chipLabelOn]}>Pay listed</Text>
              </TouchableOpacity>
            </View>
            <Text style={styles.filterLabel}>Company type</Text>
            <EmployerCategoryFilter selected={filters.employerFilter} onChange={(employerFilter) => set({ employerFilter })} />
            <Text style={styles.filterLabel}>Availability</Text>
            <JobStatusFilter status={filters.jobStatus} onChange={(jobStatus) => set({ jobStatus })} />
            <Text style={styles.filterLabel}>Source</Text>
            <View style={styles.companyFilter} accessibilityRole="radiogroup" accessibilityLabel="Source">
              {sourceFilterOptions.map(({ value, label }) => (
                <TouchableOpacity key={value} accessibilityRole="radio" aria-checked={filters.sourceFilter === value} style={[styles.chip, filters.sourceFilter === value && styles.chipOn]} onPress={() => set({ sourceFilter: value as CatalogFilterValues["sourceFilter"] })}>
                  <Text style={[styles.chipLabel, filters.sourceFilter === value && styles.chipLabelOn]}>{label}</Text>
                </TouchableOpacity>
              ))}
            </View>
            <Text style={styles.filterLabel}>Requirements</Text>
            <RequirementFilter
              hideUsCitizenshipRequired={filters.hideUsCitizenshipRequired}
              hideAdvancedDegreeRequired={filters.hideAdvancedDegreeRequired}
              onHideUsCitizenshipRequiredChange={(hideUsCitizenshipRequired) => set({ hideUsCitizenshipRequired })}
              onHideAdvancedDegreeRequiredChange={(hideAdvancedDegreeRequired) => set({ hideAdvancedDegreeRequired })}
            />
          </ScrollView>
          <View style={styles.filterSheetActions}>
            <View style={styles.filterSheetApply}>
              <ActionButton label="Show roles" onPress={onClose} />
            </View>
            <TouchableOpacity accessibilityRole="button" onPress={() => onFiltersChange(emptyCatalogFilters)} style={styles.filterSheetClear}>
              <Text style={styles.clearFiltersText}>Clear</Text>
            </TouchableOpacity>
          </View>
        </View>
      </View>
    </Modal>
  );
}

const coverageStateLabels: Record<CompanyCoverageState, string> = {
  "direct-published": "Direct source",
  "direct-shadow": "Direct source in review",
  "feed-observed": "Internship observed",
  "candidate-only": "Company candidate",
};

function CompanyCoverageDisclosure() {
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState("");
  const [coverage, setCoverage] = useState<CompanyCoverageResponse>();
  const [error, setError] = useState(false);
  useEffect(() => {
    if (Platform.OS !== "web") return;
    let active = true;
    const timeout = setTimeout(() => {
      const normalized = query.trim();
      void api<CompanyCoverageResponse>(
        `/coverage?limit=12${normalized ? `&q=${encodeURIComponent(normalized)}` : ""}`,
        "",
      )
        .then((response) => {
          if (active) {
            setCoverage(response);
            setError(false);
          }
        })
        .catch(() => {
          if (active) setError(true);
        });
    }, query.trim() ? 250 : 0);
    return () => {
      active = false;
      clearTimeout(timeout);
    };
  }, [query]);
  if (Platform.OS !== "web") return null;
  return (
    <View style={styles.coverageRegion}>
      <TouchableOpacity
        accessibilityRole="button"
        aria-expanded={expanded}
        onPress={() => setExpanded((value) => !value)}
        style={styles.coverageToggle}
      >
        <View style={styles.coverageToggleCopy}>
          <Text style={styles.coverageToggleTitle}>Company coverage</Text>
          <Text style={styles.coverageToggleSummary}>
            {coverage
              ? `${coverage.counts.internshipObserved.toLocaleString()} companies with current internship evidence`
              : error
                ? "Coverage unavailable"
                : "Loading coverage…"}
          </Text>
        </View>
        <Text style={styles.filterToggleGlyph}>{expanded ? "−" : "+"}</Text>
      </TouchableOpacity>
      {expanded ? (
        <View style={styles.coveragePanel}>
          {coverage ? (
            <View style={styles.coverageStats}>
              <View>
                <Text style={styles.coverageStatValue}>{coverage.counts.activeListingObservations.toLocaleString()}</Text>
                <Text style={styles.coverageStatLabel}>listing observations</Text>
              </View>
              <View>
                <Text style={styles.coverageStatValue}>{coverage.counts.directPublished}</Text>
                <Text style={styles.coverageStatLabel}>direct sources</Text>
              </View>
              <View>
                <Text style={styles.coverageStatValue}>{coverage.counts.directShadow}</Text>
                <Text style={styles.coverageStatLabel}>in review</Text>
              </View>
            </View>
          ) : null}
          <Text style={styles.coverageExplanation}>
            Search the tracked company universe. Community-feed evidence and reviewed employer sources are labeled separately.
          </Text>
          <PlainTextInput
            value={query}
            onChangeText={setQuery}
            accessibilityLabel="Search company coverage"
            placeholder="Search tracked companies"
            placeholderTextColor={colors.placeholder}
            style={styles.coverageSearch}
          />
          {error ? (
            <Text style={styles.coverageExplanation}>We couldn’t load coverage right now.</Text>
          ) : coverage?.companies.length ? (
            <View style={styles.coverageResults}>
              {coverage.companies.map((company) => (
                <View key={company.companyId} style={styles.coverageRow}>
                  <View style={styles.coverageCompanyCopy}>
                    <Text style={styles.coverageCompany}>{company.displayName}</Text>
                    <Text style={styles.coverageCompanyState}>
                      {coverageStateLabels[company.coverageState]}
                      {company.directProviders.length ? ` · ${company.directProviders.join(", ")}` : ""}
                    </Text>
                  </View>
                  <Text style={styles.coverageRoleCount}>
                    {company.activeListingCount ? `${company.activeListingCount} listing${company.activeListingCount === 1 ? "" : "s"}` : "No current listings"}
                  </Text>
                </View>
              ))}
            </View>
          ) : coverage && query.trim() ? (
            <Text style={styles.coverageExplanation}>No tracked company matches that search.</Text>
          ) : null}
          {coverage ? (
            <Text style={styles.coverageAsOf}>
              Snapshot {new Date(coverage.generatedAt).toLocaleDateString()}
            </Text>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function TabNavigation({
  active,
  onChange,
  rail = false,
  badgeCount = 0,
}: {
  active: "roles" | "queue" | "catalog" | "profile";
  onChange: (tab: "roles" | "queue" | "catalog" | "profile") => void;
  rail?: boolean;
  badgeCount?: number;
}) {
  const tabs = [
    { key: "roles", label: "Roles", icon: "briefcase-outline", activeIcon: "briefcase" },
    { key: "queue", label: "Queue", accessibilityLabel: "Apply queue", icon: "albums-outline", activeIcon: "albums" },
    { key: "catalog", label: "Catalog", accessibilityLabel: "Catalog search", icon: "search-outline", activeIcon: "search" },
    { key: "profile", label: "Profile", icon: "person-outline", activeIcon: "person" },
  ] as const;
  return (
    <View style={[styles.nav, rail && styles.navRail]} accessibilityRole="tablist">
      {tabs.map((item) => {
        const selected = active === item.key;
        const badge = item.key === "queue" ? badgeCount : 0;
        return (
          <TouchableOpacity
            key={item.key}
            accessibilityRole="tab"
            aria-selected={selected}
            accessibilityLabel={"accessibilityLabel" in item && item.accessibilityLabel ? item.accessibilityLabel : item.label}
            onPress={() => onChange(item.key)}
            style={[styles.navItem, rail && styles.navRailItem]}
          >
            <View style={styles.navIconWrap}>
              <Ionicons
                name={selected ? item.activeIcon : item.icon}
                size={22}
                color={selected ? colors.ink : colors.muted}
              />
              {badge > 0 ? (
                <View style={styles.navBadge} accessibilityLabel={`${badge} roles in queue`}>
                  <Text style={styles.navBadgeText}>{badge > 99 ? "99+" : String(badge)}</Text>
                </View>
              ) : null}
            </View>
            <Text style={[styles.navLabel, selected && styles.navLabelActive]}>
              {item.label}
            </Text>
          </TouchableOpacity>
        );
      })}
    </View>
  );
}

function ActionButton({
  label,
  onPress,
  disabled = false,
  variant = "primary",
  compact = false,
  tight = false,
  grow = false,
  shortcut,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: "primary" | "secondary" | "danger";
  compact?: boolean;
  tight?: boolean;
  grow?: boolean;
  shortcut?: string;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      accessibilityHint={shortcut ? `Keyboard shortcut: ${shortcut}` : undefined}
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.actionButton,
        variant === "secondary" && styles.actionButtonSecondary,
        compact && styles.actionButtonCompact,
        tight && styles.actionButtonTight,
        grow && styles.actionButtonGrow,
        disabled && styles.actionButtonDisabled,
      ]}
    >
      <View style={styles.actionButtonLabel}>
        <Text
          style={[
            styles.actionButtonText,
            variant === "secondary" && styles.actionButtonTextSecondary,
          ]}
        >
          {label}
        </Text>
        {shortcut && Platform.OS === "web" ? <Text style={styles.keyboardShortcut}>{shortcut}</Text> : null}
      </View>
    </TouchableOpacity>
  );
}

function PageHeading({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description?: string;
}) {
  return (
    <View style={styles.pageHeading}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={styles.pageTitle}>{title}</Text>
      {description ? <Text style={styles.pageDescription}>{description}</Text> : null}
    </View>
  );
}

function EmptyState({
  eyebrow,
  title,
  description,
}: {
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <View style={styles.emptyState}>
      <Text style={styles.eyebrow}>{eyebrow}</Text>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyCopy}>{description}</Text>
    </View>
  );
}

type SaveFeedbackState =
  | { kind: "idle" }
  | { kind: "saving"; message: string }
  | { kind: "success"; message: string }
  | { kind: "error"; message: string };

function SaveFeedback({
  state,
  onRetry,
}: {
  state: SaveFeedbackState;
  onRetry?: () => void;
}) {
  if (state.kind === "idle") return null;
  return (
    <View
      accessibilityLiveRegion="polite"
      style={[
        styles.saveFeedback,
        state.kind === "success" && styles.saveFeedbackSuccess,
        state.kind === "error" && styles.saveFeedbackError,
      ]}
    >
      <Text style={styles.saveFeedbackText}>{state.message}</Text>
      {state.kind === "error" && onRetry ? (
        <TouchableOpacity accessibilityRole="button" onPress={onRetry}>
          <Text style={styles.saveFeedbackRetry}>Try again</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );
}

function HiddenRolePlaceholder({ onUndo }: { onUndo: () => void }) {
  return (
    <View accessibilityLiveRegion="polite" style={styles.hiddenRolePlaceholder}>
      <Text style={styles.hiddenRolePlaceholderText}>Role hidden on this device</Text>
      <TouchableOpacity accessibilityRole="button" accessibilityLabel="Undo hide" onPress={onUndo}>
        <Text style={styles.hiddenRolePlaceholderUndo}>Undo</Text>
      </TouchableOpacity>
    </View>
  );
}

function ChoiceOption({
  label,
  description,
  selected,
  onPress,
}: {
  label: string;
  description: string;
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="radio"
      aria-checked={selected}
      onPress={onPress}
      style={[styles.choiceOption, selected && styles.choiceOptionSelected]}
    >
      <View style={styles.choiceCopy}>
        <Text style={[styles.choiceLabel, selected && styles.choiceLabelSelected]}>
          {label}
        </Text>
        <Text style={styles.choiceDescription}>{description}</Text>
      </View>
      <View style={[styles.choiceMark, selected && styles.choiceMarkSelected]}>
        {selected ? <View style={styles.choiceMarkDot} /> : null}
      </View>
    </TouchableOpacity>
  );
}

function Skeleton({ width, height = 14 }: { width: number; height?: number }) {
  return (
    <View
      style={[styles.skeleton, { width, height, borderRadius: height / 2 }]}
    />
  );
}

function JobCardSkeleton() {
  return (
    <View style={styles.card}>
      <Skeleton width={104} height={12} />
      <View style={styles.skeletonGap8} />
      <Skeleton width={236} height={18} />
      <View style={styles.skeletonGap8} />
      <Skeleton width={174} height={14} />
    </View>
  );
}

function LoadingRoleCard({ index }: { index: number }) {
  const opacity = useRef(new Animated.Value(1)).current;
  const lift = useRef(new Animated.Value(0)).current;
  const motionAllowed = useContext(MotionAllowedContext);

  useEffect(() => {
    if (!motionAllowed) {
      opacity.setValue(1);
      lift.setValue(0);
      return;
    }
    opacity.setValue(0);
    lift.setValue(10);
    const animation = Animated.sequence([
      Animated.delay(index * 100),
      Animated.parallel([
        Animated.timing(opacity, { toValue: 1, duration: 240, useNativeDriver: true }),
        Animated.spring(lift, { toValue: 0, friction: 10, tension: 100, useNativeDriver: true }),
      ]),
    ]);
    animation.start();
    return () => animation.stop();
  }, [index, lift, motionAllowed, opacity]);

  return (
    <Animated.View style={{ opacity, transform: [{ translateY: lift }] }}>
      <JobCardSkeleton />
    </Animated.View>
  );
}

function launchInterval(previousOpenedAt: string | null) {
  if (!previousOpenedAt) return "your last visit";
  const date = new Date(previousOpenedAt);
  if (Number.isNaN(date.valueOf())) return "your last visit";
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
  }).format(date);
}

function LaunchInbox({
  inbox,
  onOpen,
  onViewAll,
  applicationStatuses,
  queuedJobIds,
  onAddToQueue,
  queuingJobIds,
  hiddenJobIds,
  onHideLocally,
  onRemoveFromQueue,
  hiddenFeedbackJob,
  onUndoHide,
  onOpenGroup,
  queueCount,
  onOpenQueue,
}: {
  inbox: LaunchInbox;
  onOpen: (job: Job) => void;
  onViewAll: () => void;
  applicationStatuses: Map<string, string>;
  queuedJobIds?: Set<string>;
  onAddToQueue: (job: Job) => void;
  queuingJobIds: Set<string>;
  hiddenJobIds: Set<string>;
  onHideLocally: (job: Job) => void;
  onRemoveFromQueue?: (job: Job) => void;
  hiddenFeedbackJob?: Job;
  onUndoHide: () => void;
  onOpenGroup: (group: CatalogGroupRow, details?: CatalogGroupDetails) => void;
  queueCount?: number;
  onOpenQueue?: () => void;
}) {
  const visibleJobs = inbox.jobs.filter(
    (job) => !hiddenJobIds.has(job.jobId) || hiddenFeedbackJob?.jobId === job.jobId,
  );
  const groupedRows = inbox.groups?.map((details) => details.group) ?? [];
  if (groupedRows.length) return (
    <FlatList
      style={styles.list}
      data={groupedRows}
      extraData={[applicationStatuses, queuingJobIds]}
      keyExtractor={(group) => group.groupId}
      contentContainerStyle={styles.feedListContent}
      ListHeaderComponent={
        <View style={styles.inboxHeader}>
          <Text accessibilityLabel={`${inbox.total} new matches`} style={styles.inboxCount}>{inbox.total}</Text>
          <Text style={styles.inboxTitle}>new matches</Text>
          <Text style={styles.inboxDescription}>Grouped by employer release and verified program details</Text>
          <View style={styles.inboxActions}>
            <TouchableOpacity accessibilityRole="button" onPress={onViewAll} style={[styles.inboxViewAll, styles.inboxViewAllInline]}>
              <Text style={styles.inboxViewAllText}>Browse the catalog</Text>
            </TouchableOpacity>
            {Platform.OS === "web" && onOpenQueue && queueCount !== undefined ? (
              <QueuePillButton count={queueCount} onPress={onOpenQueue} />
            ) : null}
          </View>
        </View>
      }
      renderItem={({ item, index }) => {
        const role = catalogCardKind(item) === "role"
          ? visibleJobs.find((job) => job.jobId === item.featuredRole.jobId)
          : undefined;
        if (role) {
          return (
            <NewRoleCard
              job={role}
              onOpen={() => onOpen(role)}
              applicationStatus={applicationStatuses.get(role.jobId)}
              isQueued={queuedJobIds?.has(role.jobId)}
              index={index}
              onAddToQueue={() => onAddToQueue(role)}
              isAddingToQueue={queuingJobIds.has(role.jobId)}
              onHideLocally={() => onHideLocally(role)}
              onRemoveFromQueue={onRemoveFromQueue ? () => onRemoveFromQueue(role) : undefined}
            />
          );
        }
        return (
          <CatalogGroupCard
            group={item}
            onOpenGroup={() => onOpenGroup(item, inbox.groups?.[index])}
            onOpenRole={onOpen}
            onAddToQueue={item.featuredRole ? () => onAddToQueue(catalogRoleJob(item.featuredRole)) : undefined}
            isAddingToQueue={item.featuredRole ? queuingJobIds.has(item.featuredRole.jobId) : false}
            onHideLocally={item.featuredRole ? () => onHideLocally(catalogRoleJob(item.featuredRole)) : undefined}
            applicationStatus={item.featuredRole ? applicationStatuses.get(item.featuredRole.jobId) : undefined}
            isQueued={item.featuredRole ? queuedJobIds?.has(item.featuredRole.jobId) : undefined}
            onRemoveFromQueue={item.featuredRole && onRemoveFromQueue ? () => onRemoveFromQueue(catalogRoleJob(item.featuredRole)) : undefined}
          />
        );
      }}
      ListFooterComponent={
        <TouchableOpacity
          accessibilityRole="button"
          onPress={onViewAll}
          style={[styles.inboxViewAll, styles.inboxViewAllFooter]}
        >
          <Text style={styles.inboxViewAllText}>Browse the catalog</Text>
        </TouchableOpacity>
      }
    />
  );
  return (
    <FlatList
      style={styles.list}
      data={visibleJobs}
      extraData={[applicationStatuses, queuingJobIds]}
      keyExtractor={(job) => job.jobId}
      contentContainerStyle={styles.feedListContent}
      ListHeaderComponent={
        <View style={styles.inboxHeader}>
          <Text style={styles.eyebrow}>Your radar</Text>
          <Text accessibilityLabel={`${visibleJobs.length} new matches`} style={styles.inboxCount}>
            {visibleJobs.length}
          </Text>
          <Text style={styles.inboxTitle}>new matches</Text>
          <Text style={styles.inboxDescription}>
            Matched your alerts since {launchInterval(inbox.previousOpenedAt)}
          </Text>
          {inbox.hasMore ? (
            <Text style={styles.inboxOverflow}>Showing the newest 50.</Text>
          ) : null}
          <View style={styles.inboxActions}>
            <TouchableOpacity
              accessibilityRole="button"
              onPress={onViewAll}
              style={[styles.inboxViewAll, styles.inboxViewAllInline]}
            >
              <Text style={styles.inboxViewAllText}>Browse the catalog</Text>
            </TouchableOpacity>
            {Platform.OS === "web" && onOpenQueue && queueCount !== undefined ? (
              <QueuePillButton count={queueCount} onPress={onOpenQueue} />
            ) : null}
          </View>
          <Text style={styles.inboxSectionLabel}>New matches</Text>
        </View>
      }
      renderItem={({ item, index }) =>
        hiddenFeedbackJob?.jobId === item.jobId ? (
          <HiddenRolePlaceholder onUndo={onUndoHide} />
        ) : (
          <NewRoleCard
            job={item}
            index={index}
            onOpen={() => onOpen(item)}
            applicationStatus={applicationStatuses.get(item.jobId)}
            isQueued={queuedJobIds?.has(item.jobId)}
            onAddToQueue={() => onAddToQueue(item)}
            isAddingToQueue={queuingJobIds.has(item.jobId)}
            onHideLocally={() => onHideLocally(item)}
            onRemoveFromQueue={onRemoveFromQueue ? () => onRemoveFromQueue(item) : undefined}
          />
        )}
      ListEmptyComponent={
        <EmptyState
          eyebrow="New matches"
          title="Those roles are hidden on this device."
          description="You can restore them from Profile whenever you want."
        />
      }
      ListFooterComponent={
        visibleJobs.length ? (
          <TouchableOpacity
            accessibilityRole="button"
            onPress={onViewAll}
            style={[styles.inboxViewAll, styles.inboxViewAllFooter]}
          >
            <Text style={styles.inboxViewAllText}>Browse the catalog</Text>
          </TouchableOpacity>
        ) : null
      }
    />
  );
}

function CatalogPaginationFooter({
  loading,
  error,
  reachedEnd,
  searching,
  onRetry,
}: {
  loading: boolean;
  error?: string;
  reachedEnd: boolean;
  searching: boolean;
  onRetry: () => void;
}) {
  if (loading) {
    return (
      <View accessibilityRole="progressbar" accessibilityLabel={searching ? "Loading more search results" : "Loading more internships"} style={styles.catalogPagination}>
        <Text style={styles.catalogPaginationText}>{searching ? "Loading more search results…" : "Loading more internships…"}</Text>
      </View>
    );
  }
  if (error) {
    return (
      <View accessibilityRole="alert" style={styles.catalogPagination}>
        <Text style={styles.catalogPaginationText}>We couldn’t load more internships.</Text>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Try loading more internships again" onPress={onRetry} style={styles.catalogPaginationRetry}>
          <Text style={styles.catalogPaginationRetryText}>Try again</Text>
        </TouchableOpacity>
      </View>
    );
  }
  if (reachedEnd) {
    return (
      <View accessibilityRole="text" accessibilityLabel="You have reached the end of the catalog" style={styles.catalogPagination}>
        <Text style={styles.catalogPaginationText}>You’ve reached the end</Text>
      </View>
    );
  }
  return null;
}

/**
 * CATALOG SURFACE CONTRACT
 * THESIS: the query field is the spine. A pinned search bar with live counts sits
 * above a dense tile grid; the category default — one tall card per row in a
 * half-empty column — is refused.
 * OWN-WORLD: the product's existing palette and type (ink, signal, muted on
 * surface; 12–17 pt), sharing the queue, hide and swipe vocabulary of every role
 * card so an action means one thing everywhere.
 * FIRST VIEWPORT: query, active-facet tokens, result count, then the lane of new
 * roles, then the grid.
 * SIGNATURE: the newness lane — what appeared since your last visit leads the
 * catalog, and a query narrows the lane and the grid together.
 * RISK: density. Two columns on a phone can crowd long employer names, so tiles
 * wrap to three lines of title before they truncate.
 */
function CatalogScreen({
  groups,
  query,
  onQueryChange,
  filters,
  onFiltersChange,
  loading,
  error,
  loadingMore,
  moreError,
  reachedEnd,
  onLoadMore,
  onRetryLoadMore,
  onRetry,
  onOpenGroup,
  onOpenRole,
  onAddToQueue,
  onHideLocally,
  onRemoveFromQueue,
  queuingJobIds,
  applicationStatuses,
  queuedJobIds,
  queueCount,
  onOpenQueue,
  queue,
  queueJobs,
  onOpenQueuedRole,
  onBulkOpenQueue,
  newJobIds,
  newSinceLabel,
  dayZone,
  attentive = true,
  hiddenJobIds,
  hiddenFeedbackJob,
  onUndoHide,
}: {
  groups: CatalogGroupRow[];
  query: string;
  onQueryChange: (value: string) => void;
  filters: CatalogFilterValues;
  onFiltersChange: (next: CatalogFilterValues) => void;
  loading: boolean;
  error?: string;
  loadingMore: boolean;
  moreError?: string;
  reachedEnd: boolean;
  onLoadMore: () => void;
  onRetryLoadMore: () => void;
  onRetry: () => void;
  onOpenGroup: (group: CatalogGroupRow) => void;
  onOpenRole: (job: Job) => void;
  onAddToQueue?: (job: Job) => void | Promise<boolean>;
  onHideLocally?: (job: Job) => void;
  onRemoveFromQueue?: (job: Job) => void;
  queuingJobIds?: Set<string>;
  applicationStatuses?: Map<string, string>;
  queuedJobIds?: Set<string>;
  queueCount?: number;
  onOpenQueue?: () => void;
  queue?: Application[];
  queueJobs?: Job[];
  onOpenQueuedRole?: (target: { jobId: string; applyUrl: string }) => void;
  onBulkOpenQueue?: (targets: Array<{ jobId: string; applyUrl: string }>) => void;
  /** Roles that appeared since the last visit, offered as the catalog's first lane. */
  newJobIds?: Set<string>;
  newSinceLabel?: string;
  /** The zone release days are read in; UTC unless the reader chose their own. */
  dayZone: string;
  /** False while the surface is mounted but hidden, so nothing animates unseen. */
  attentive?: boolean;
  /** Device-local hides, so a hidden card leaves this surface too. */
  hiddenJobIds?: Set<string>;
  hiddenFeedbackJob?: Job;
  onUndoHide?: () => void;
}) {
  const { width } = useWindowDimensions();
  // The queue panel is a desktop workspace aid. Native keeps browsing focused;
  // queued roles remain one tap away in the Queue tab.
  const showQueueFixture = Platform.OS === "web" && queue !== undefined;
  const showQueueSidebar = Platform.OS === "web" && width >= 1280 && queue !== undefined;
  const [queueOpen, setQueueOpen] = useState(false);
  const [sheetVisible, setSheetVisible] = useState(false);
  const [queryFocused, setQueryFocused] = useState(false);
  const [calendarOpen, setCalendarOpen] = useState(false);
  // Below this width the query field needs the whole row; the filter control
  // drops to its own line rather than truncating the placeholder.
  const stackedSearch = width < 560;
  // The sidebar costs about a third of the window, so it caps the grid at three.
  const columns = showQueueSidebar
    ? (width >= 1660 ? 4 : 3)
    : width >= 1400 ? 4 : width >= 840 ? 3 : 2;
  const tokens = catalogFilterTokens(filters);
  const searching = Boolean(query.trim());
  // A role hidden on this device leaves this surface too, and the card that was
  // just hidden keeps its place so Undo is right where the reader was looking.
  const isHiddenGroup = (group: CatalogGroupRow) => {
    const hidden = hiddenJobIds;
    if (!hidden?.size || !group.roleIds?.length) return false;
    return group.roleIds.every((roleId) => hidden.has(roleId));
  };
  const isUndoGroup = (group: CatalogGroupRow) => Boolean(hiddenFeedbackJob && group.roleIds?.includes(hiddenFeedbackJob.jobId));
  const visibleGroups = useMemo(
    () => groups.filter((group) => !isHiddenGroup(group) || isUndoGroup(group)),
    [groups, hiddenJobIds, hiddenFeedbackJob],
  );
  const roleCount = visibleGroups.reduce((total, group) => total + group.roleCount, 0);
  const employerCount = new Set(visibleGroups.map((group) => group.company)).size;
  // A lane exists only when the launch inbox says something is genuinely new.
  const laneGroups = newJobIds?.size
    ? visibleGroups.filter((group) => group.roleIds?.some((roleId) => newJobIds.has(roleId)) || Boolean(group.featuredRole && newJobIds.has(group.featuredRole.jobId)))
    : [];
  const rows = useMemo(() => {
    const chunked: CatalogGroupRow[][] = [];
    for (let index = 0; index < visibleGroups.length; index += columns) {
      chunked.push(visibleGroups.slice(index, index + columns));
    }
    return chunked;
  }, [columns, visibleGroups]);
  const searchFieldRef = useRef<TextInput>(null);
  const openNextQueuedRole = () => {
    const target = queue
      ?.map((item) => queueEntryTarget(item, queueJobs ?? []))
      .find((item): item is { jobId: string; applyUrl: string } => item !== undefined);
    if (target) onOpenQueuedRole?.(target);
  };
  const availableQueuedTargets = queue
    ?.map((item) => queueEntryTarget(item, queueJobs ?? []))
    .filter((item): item is { jobId: string; applyUrl: string } => item !== undefined) ?? [];
  useWebKeyboardShortcuts([
    { key: "/", onPress: () => searchFieldRef.current?.focus() },
    { key: "n", onPress: openNextQueuedRole, enabled: Boolean(availableQueuedTargets.length && onOpenQueuedRole) },
    { key: "5", onPress: () => onBulkOpenQueue?.(selectBulkTargets(availableQueuedTargets, 5)), enabled: Boolean(onBulkOpenQueue && availableQueuedTargets.length >= 5) },
    { key: "t", onPress: () => onBulkOpenQueue?.(selectBulkTargets(availableQueuedTargets, 10)), enabled: Boolean(onBulkOpenQueue && availableQueuedTargets.length >= 10) },
    { key: "h", onPress: () => onBulkOpenQueue?.(selectBulkTargets(availableQueuedTargets, "half")), enabled: Boolean(onBulkOpenQueue && availableQueuedTargets.length >= 2) },
    { key: "a", onPress: () => onBulkOpenQueue?.(selectBulkTargets(availableQueuedTargets, "all")), enabled: Boolean(onBulkOpenQueue && availableQueuedTargets.length >= 2) },
  ]);
  const cardProps: CatalogCardProps = {
    status: filters.jobStatus,
    applicationStatuses,
    queuedJobIds,
    queuingJobIds,
    newJobIds,
    onOpenGroup,
    onOpenRole,
    onAddToQueue,
    onHideLocally,
    onRemoveFromQueue,
  };
  return (
    <View style={[styles.roleWorkspace, showQueueSidebar && styles.roleWorkspaceWide]}>
      <View style={[styles.roleFeedColumn, showQueueSidebar && styles.catalogColumnWide]}>
        <View style={[styles.catalogSearchBlock, showQueueSidebar && styles.catalogSearchBlockWide]}>
          <View style={[styles.catalogSearchRow, stackedSearch && styles.catalogSearchRowStacked]}>
            <View style={[styles.catalogSearchField, queryFocused && styles.catalogSearchFieldFocused]}>
              <Ionicons name="search-outline" size={17} color={colors.muted} />
              <TextInput
                ref={searchFieldRef}
                value={query}
                onChangeText={onQueryChange}
                accessibilityLabel="Search roles, companies, and locations"
                autoComplete="off"
                autoCorrect={false}
                secureTextEntry={false}
                textContentType="none"
                returnKeyType="search"
                placeholder="Search roles, companies, locations"
                placeholderTextColor={colors.placeholder}
                selectionColor={colors.signal}
                onFocus={() => setQueryFocused(true)}
                onBlur={() => setQueryFocused(false)}
                onKeyPress={(event) => {
                  if (event.nativeEvent.key === "Escape") onQueryChange("");
                }}
                style={styles.catalogSearchInput}
              />
              {query ? (
                <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear search" onPress={() => onQueryChange("")} style={styles.catalogSearchClear}>
                  <Ionicons name="close-circle" size={17} color={colors.muted} />
                </TouchableOpacity>
              ) : null}
            </View>
            <View style={[styles.catalogSearchControls, stackedSearch && styles.catalogSearchControlsStacked]}>
              <FilterBar activeCount={countActiveCatalogFilters(filters)} onOpen={() => setSheetVisible(true)} />
              <View style={styles.catalogSearchControlTail}>
                <ReleaseCalendarTrigger
                  open={calendarOpen}
                  selectedDay={filters.day}
                  onToggle={() => setCalendarOpen((current) => !current)}
                />
                {!showQueueSidebar && showQueueFixture && queueCount !== undefined ? (
                  <QueuePillButton count={queueCount} expanded={queueOpen} onPress={() => setQueueOpen((open) => !open)} />
                ) : null}
              </View>
            </View>
          </View>
          {tokens.length ? (
            <View style={styles.catalogTokenRow}>
              {tokens.map((token) => (
                <TouchableOpacity
                  key={token.key}
                  accessibilityRole="button"
                  accessibilityLabel={`Remove filter ${token.label}`}
                  onPress={() => onFiltersChange({ ...filters, ...token.patch })}
                  style={styles.catalogToken}
                >
                  <Text style={styles.catalogTokenText}>{token.label}</Text>
                  <Ionicons name="close" size={13} color={colors.signal} />
                </TouchableOpacity>
              ))}
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Clear all filters" onPress={() => onFiltersChange(emptyCatalogFilters)} style={styles.catalogTokenClear}>
                <Text style={styles.catalogTokenClearText}>Clear all</Text>
              </TouchableOpacity>
            </View>
          ) : null}
          <Text style={styles.catalogSummary} accessibilityLiveRegion="polite">
            {loading
              ? "Searching the catalog…"
              : `${employerCount}${reachedEnd ? "" : "+"} ${employerCount === 1 ? "employer" : "employers"} · ${roleCount}${reachedEnd ? "" : "+"} ${roleCount === 1 ? "role" : "roles"}${searching ? ` for “${query.trim()}”` : ""}`}
          </Text>
          {calendarOpen ? (
            <ReleaseCalendarPanel
              filters={filters}
              zone={dayZone}
              selectedDay={filters.day}
              inline={stackedSearch}
              onSelectDay={(day) => onFiltersChange({ ...filters, day })}
              onClose={() => setCalendarOpen(false)}
            />
          ) : null}
        </View>
        {!showQueueSidebar && showQueueFixture && queueOpen ? (
          <QueuePanel
            queue={queue}
            jobs={queueJobs ?? []}
            onOpenQueuedRole={onOpenQueuedRole}
            onBulkOpenQueue={onBulkOpenQueue}
            onViewAll={onOpenQueue}
            onCollapse={() => setQueueOpen(false)}
          />
        ) : null}
        <FilterSheet
          visible={sheetVisible}
          filters={filters}
          onFiltersChange={onFiltersChange}
          onClose={() => setSheetVisible(false)}
        />
        <FlatList
          style={styles.roleFeedList}
          data={rows}
          extraData={[applicationStatuses, queuingJobIds, filters.jobStatus]}
          keyExtractor={(row) => row[0]?.groupId ?? "catalog-row"}
          contentContainerStyle={[styles.catalogGrid, showQueueSidebar && styles.feedListContentWide]}
          onEndReached={onLoadMore}
          onEndReachedThreshold={0.6}
          ListHeaderComponent={
            laneGroups.length && !searching ? (
              <NewnessLane groups={laneGroups} since={newSinceLabel ?? "your last visit"} attentive={attentive} {...cardProps} />
            ) : null
          }
          renderItem={({ item: row }) => (
            <View style={styles.catalogGridRow}>
              {row.map((group) => (
                isUndoGroup(group) && isHiddenGroup(group) ? (
                  <View key={group.groupId} style={styles.catalogCell}>
                    <HiddenRolePlaceholder onUndo={() => onUndoHide?.()} />
                  </View>
                ) : (
                  <CatalogGroupItem key={group.groupId} group={group} presentation="grid" {...cardProps} />
                )
              ))}
              {row.length < columns
                ? Array.from({ length: columns - row.length }, (_, index) => <View key={`catalog-filler-${index}`} style={styles.catalogCell} />)
                : null}
            </View>
          )}
          ListEmptyComponent={
            loading ? (
              <CatalogTileSkeleton count={columns * 2} columns={columns} />
            ) : error ? (
              <View style={styles.catalogUnavailable}>
                <Text style={styles.catalogEmptyTitle}>The catalog didn’t load.</Text>
                <Text style={styles.catalogEmptyCopy}>We couldn’t reach the catalog just now. Check your connection and try again.</Text>
                <View style={styles.catalogEmptyAction}>
                  <ActionButton label="Try again" onPress={onRetry} />
                </View>
              </View>
            ) : (
              <View style={styles.catalogUnavailable}>
                <Text style={styles.catalogEmptyTitle}>
                  {filters.day
                    ? `No open roles were released on ${releaseDayLabel(filters.day)}.`
                    : searching ? `Nothing matches “${query.trim()}” yet.` : "No roles match these filters."}
                </Text>
                <Text style={styles.catalogEmptyCopy}>
                  {filters.day
                    ? "Pick another day in the calendar, or clear the day to see the whole catalog."
                    : tokens.length
                      ? "Remove a filter to widen the search."
                      : "Try a company, a role, or a location with fewer terms."}
                </Text>
                <View style={styles.catalogEmptyAction}>
                  {filters.day ? (
                    <ActionButton label="Clear day" variant="secondary" onPress={() => onFiltersChange({ ...filters, day: undefined })} />
                  ) : searching ? (
                    <ActionButton label="Clear search" variant="secondary" onPress={() => onQueryChange("")} />
                  ) : tokens.length ? (
                    <ActionButton label="Clear filters" variant="secondary" onPress={() => onFiltersChange(emptyCatalogFilters)} />
                  ) : null}
                </View>
              </View>
            )
          }
          ListFooterComponent={
            <CatalogPaginationFooter
              loading={loadingMore}
              error={moreError}
              reachedEnd={reachedEnd}
              searching={searching}
              onRetry={onRetryLoadMore}
            />
          }
        />
      </View>
      {showQueueSidebar && queue ? (
        <View style={styles.queueSidebar}>
          <QueuePanel
            queue={queue}
            jobs={queueJobs ?? []}
            onOpenQueuedRole={onOpenQueuedRole}
            onBulkOpenQueue={onBulkOpenQueue}
            onViewAll={onOpenQueue}
            maxRows={8}
          />
        </View>
      ) : null}
    </View>
  );
}

function AppLoadingSkeleton() {
  const { width } = useWindowDimensions();
  const usesNavigationRail = width >= 700;
  return (
    <SafeAreaView
      style={styles.screen}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading your internships"
    >
      <View style={[styles.appShell, usesNavigationRail && styles.appShellWide]}>
        {usesNavigationRail ? (
          <View style={[styles.skeletonNav, styles.skeletonNavRail]}>
            <Skeleton width={40} height={14} />
            <Skeleton width={44} height={14} />
            <Skeleton width={46} height={14} />
          </View>
        ) : null}
        <View style={styles.appMain}>
          <View style={styles.pageColumn}>
          <View style={styles.skeletonPage}>
            <View style={styles.loadingTitleGroup}>
              <Skeleton width={94} height={12} />
              <View style={styles.skeletonGap8} />
              <Skeleton width={168} height={28} />
            </View>
            <View style={styles.skeletonSearch} />
            <View style={styles.skeletonSection}>
              <Skeleton width={132} height={12} />
              <View style={styles.skeletonGap8} />
              <Skeleton width={248} height={14} />
            </View>
            {[0, 1, 2].map((index) => <LoadingRoleCard key={index} index={index} />)}
          </View>
          </View>
        </View>
        {!usesNavigationRail ? (
          <View style={styles.skeletonNav}>
            <Skeleton width={40} height={14} />
            <Skeleton width={44} height={14} />
            <Skeleton width={46} height={14} />
          </View>
        ) : null}
      </View>
    </SafeAreaView>
  );
}

function AccountLoadError({
  message,
  onRetry,
  onSignOut,
}: {
  message: string;
  onRetry: () => void;
  onSignOut: () => void;
}) {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.loadErrorScreen}>
        <PageHeading
          eyebrow="Connection"
          title="We couldn’t load your account."
          description={message}
        />
        <ActionButton label="Try again" onPress={onRetry} />
        <View style={styles.buttonGap} />
        <ActionButton label="Sign out" variant="secondary" onPress={onSignOut} />
      </View>
    </SafeAreaView>
  );
}

function SessionRecoveryError({
  message,
  onRetry,
  onContinueBrowsing,
}: {
  message: string;
  onRetry: () => void;
  onContinueBrowsing: () => void;
}) {
  return (
    <SafeAreaView style={styles.screen}>
      <View style={styles.loadErrorScreen}>
        <PageHeading
          eyebrow="Connection"
          title="We couldn’t refresh your sign-in."
          description={message}
        />
        <ActionButton label="Try again" onPress={onRetry} />
        <View style={styles.buttonGap} />
        <ActionButton label="Continue browsing" variant="secondary" onPress={onContinueBrowsing} />
      </View>
    </SafeAreaView>
  );
}

function ProfileLoadingSkeleton() {
  return (
    <ScrollView
      style={styles.list}
      contentContainerStyle={styles.profileContent}
      accessibilityRole="progressbar"
      accessibilityLabel="Loading your profile"
    >
      <Skeleton width={218} height={32} />
      <View style={styles.skeletonProfileGap} />
      {[0, 1, 2, 3].map((item) => (
        <View key={item} style={styles.skeletonField}>
          <Skeleton width={96} height={12} />
          <View style={styles.skeletonGap8} />
          <View style={styles.skeletonInput} />
        </View>
      ))}
      <View style={styles.skeletonButton} />
      <View style={styles.skeletonProfileGap} />
      <Skeleton width={112} height={22} />
      <View style={styles.skeletonGap12} />
      <View style={styles.skeletonInput} />
    </ScrollView>
  );
}

function AppContent() {
  const { width } = useWindowDimensions();
  const usesNavigationRail = width >= 700;
  const [token, setToken] = useState<string>();
  const tokenRef = useRef<string | undefined>(undefined);
  tokenRef.current = token;
  const [ready, setReady] = useState(false);
  const [sessionRecoveryMessage, setSessionRecoveryMessage] = useState<string>();
  const sessionRequestId = useRef(0);
  const privateRequestId = useRef(0);
  const [tab, setTab] = useState<"roles" | "queue" | "catalog" | "profile">("roles");
  // Release days default to UTC; a reader can ask for their own zone instead.
  const { zone: dayZone } = useDayZone();
  const [queueSheetVisible, setQueueSheetVisible] = useState(false);
  const [preferences, setPreferences] = useState<Preference>();
  const [preferenceError, setPreferenceError] = useState<string>();
  const [jobs, setJobs] = useState<Job[]>([]);
  const [catalogGroups, setCatalogGroups] = useState<CatalogGroupRow[]>([]);
  const [catalogError, setCatalogError] = useState<string>();
  const [catalogInitialLoading, setCatalogInitialLoading] = useState(true);
  const [catalogLoadingMore, setCatalogLoadingMore] = useState(false);
  const [catalogMoreError, setCatalogMoreError] = useState<string>();
  const [nextCatalogCursor, setNextCatalogCursor] = useState<string>();
  const [catalogRefresh, setCatalogRefresh] = useState(0);
  const [applications, setApplications] = useState<Application[]>([]);
  const [queuingJobIds, setSavingJobIds] = useState<Set<string>>(() => new Set());
  const pendingQueueIds = useRef<Set<string>>(new Set());
  const dequeueAfterSave = useRef<Set<string>>(new Set());
  const [hiddenJobIds, setHiddenJobIds] = useState<Set<string>>(() => new Set());
  const [hiddenFeedbackJob, setHiddenFeedbackJob] = useState<Job>();
  const [query, setQuery] = useState("");
  const [catalogFilters, setCatalogFilters] = useState<CatalogFilterValues>(emptyCatalogFilters);
  const [selectedJob, setSelectedJob] = useState<Job | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState<string>();
  const [selectedGroup, setSelectedGroup] = useState<CatalogGroupDetails>();
  const [selectedGroupVisible, setSelectedGroupVisible] = useState(false);
  const [selectedGroupLoading, setSelectedGroupLoading] = useState(false);
  const [selectedGroupError, setSelectedGroupError] = useState<string>();
  const [selectedMatchReasons, setSelectedMatchReasons] = useState<FilterMatchReason[]>([]);
  const [selectedExclusionsApplied, setSelectedExclusionsApplied] = useState(false);
  const [jobRouteState, setJobRouteState] = useState<JobRouteState>("idle");
  const routedJobId = useRef<string | undefined>(undefined);
  const detailVisible = useRef(false);
  const detailDismissalPending = useRef(false);
  const returnToGroupedRoles = useRef(false);
  const pendingDestination = useRef<AppDestination | undefined>(undefined);
  const [launchInbox, setLaunchInbox] = useState<LaunchInbox>();
  const [launchLoaded, setLaunchLoaded] = useState(false);
  const launchRequestToken = useRef<string | undefined>(undefined);
  const launchRequestId = useRef(0);
  const legacyAlertMigrationToken = useRef<string | undefined>(undefined);
  const catalogGroupsRef = useRef<CatalogGroupRow[]>([]);
  const catalogCursorRef = useRef<string | undefined>(undefined);
  const catalogRequestGeneration = useRef(0);
  const catalogRequestInFlight = useRef(false);
  const groupRequestGuard = useRef(createLatestRequestGuard());
  const changeTab = (nextTab: "roles" | "queue" | "catalog" | "profile") => {
    setTab(nextTab);
  };
  const clearPrivateState = () => {
    privateRequestId.current += 1;
    setApplications([]);
    setSavingJobIds(new Set());
  };
  const acceptSessionToken = (value: string) => {
    if (tokenRef.current !== value) clearPrivateState();
    tokenRef.current = value;
    setToken(value);
  };
  const finishLocalSignOut = () => {
    sessionRequestId.current += 1;
    tokenRef.current = undefined;
    clearPrivateState();
    setToken(undefined);
    setSessionRecoveryMessage(undefined);
  };
  const endSession = async () => {
    const currentToken = tokenRef.current;
    finishLocalSignOut();
    await signOut(currentToken);
  };
  const recoverSession = async (forceRefresh = false) => {
    const requestId = ++sessionRequestId.current;
    const result = await restoreSession({ forceRefresh });
    if (sessionRequestId.current !== requestId) return result;
    if (result.status === "authenticated") {
      acceptSessionToken(result.token);
      setSessionRecoveryMessage(undefined);
    } else if (result.status === "temporarily_unavailable") {
      setSessionRecoveryMessage(result.message);
    } else {
      finishLocalSignOut();
    }
    return result;
  };
  useEffect(() => {
    void recoverSession().finally(() => setReady(true));
  }, []);
  useEffect(() => {
    let active = true;
    void installationApi<Preference>("/preferences")
      .then((value) => {
        if (active) {
          setPreferences(value);
          setPreferenceError(undefined);
        }
      })
      .catch((error) => {
        if (active) {
          setPreferences(defaultPreference);
          setPreferenceError(error instanceof Error ? error.message : "Settings could not be loaded.");
        }
      });
    return () => { active = false; };
  }, []);
  useEffect(() => {
    const refresh = () => {
      void recoverSession();
    };
    const interval = setInterval(refresh, 45 * 60 * 1_000);
    const appStateSubscription = AppState.addEventListener("change", (state) => {
      if (state === "active") refresh();
    });
    return () => {
      clearInterval(interval);
      appStateSubscription.remove();
    };
  }, []);
  useEffect(() => {
    let active = true;
    void responseCache.get<string[]>(hiddenRolesCacheKey).then((cached) => {
      if (active && cached) setHiddenJobIds(new Set(cached));
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    let active = true;
    // Show the last successful public catalog immediately. This is especially
    // useful after onboarding, when the launch inbox intentionally has no
    // historical "new" roles to show yet.
    void responseCache.get<CatalogCache>(catalogCacheKey).then((cached) => {
      if (active && cached?.groups.length && !catalogGroupsRef.current.length) {
        catalogGroupsRef.current = cached.groups;
        catalogCursorRef.current = cached.cursor;
        setCatalogGroups(cached.groups);
        setNextCatalogCursor(cached.cursor);
      }
    });
    return () => {
      active = false;
    };
  }, []);
  useEffect(() => {
    const requestGeneration = ++catalogRequestGeneration.current;
    catalogRequestInFlight.current = true;
    catalogCursorRef.current = undefined;
    setNextCatalogCursor(undefined);
    setCatalogInitialLoading(true);
    setCatalogLoadingMore(false);
    setCatalogError(undefined);
    setCatalogMoreError(undefined);
    const catalogQuery = query.trim();
    const params = groupedCatalogParameters(catalogRequestState(catalogFilters, { query: catalogQuery, dayZone }));
    void api<GroupedCatalogPage<CatalogGroupRow>>(`/catalog?${params.toString()}`, "")
      .then((page) => {
        if (catalogRequestGeneration.current !== requestGeneration) return;
        catalogGroupsRef.current = page.groups;
        catalogCursorRef.current = page.cursor;
        setCatalogGroups(page.groups);
        setNextCatalogCursor(page.cursor);
        if (!catalogQuery && countActiveCatalogFilters(catalogFilters) === 0) {
          void responseCache.set(catalogCacheKey, page);
        }
      })
      .catch((error) => {
        if (catalogRequestGeneration.current === requestGeneration) {
          setCatalogError(
            error instanceof Error
              ? error.message
              : "We couldn't refresh internships right now.",
          );
        }
      })
      .finally(() => {
        if (catalogRequestGeneration.current === requestGeneration) {
          catalogRequestInFlight.current = false;
          setCatalogInitialLoading(false);
        }
      });
    return () => {
      if (catalogRequestGeneration.current === requestGeneration) {
        catalogRequestGeneration.current += 1;
        catalogRequestInFlight.current = false;
      }
    };
  }, [catalogRefresh, query, catalogFilters, dayZone]);
  const loadNextCatalogPage = (retry = false) => {
    const cursor = catalogCursorRef.current;
    if (!cursor || catalogRequestInFlight.current || (!retry && catalogMoreError)) return;
    const requestGeneration = catalogRequestGeneration.current;
    catalogRequestInFlight.current = true;
    setCatalogLoadingMore(true);
    setCatalogMoreError(undefined);
    const catalogQuery = query.trim();
    const params = groupedCatalogParameters(
      catalogRequestState(catalogFilters, { query: catalogQuery, dayZone }),
      { cursor },
    );
    void api<GroupedCatalogPage<CatalogGroupRow>>(`/catalog?${params.toString()}`, "")
      .then((page) => {
        if (catalogRequestGeneration.current !== requestGeneration) return;
        const nextGroups = appendGroupedCatalogPage(catalogGroupsRef.current, page);
        catalogGroupsRef.current = nextGroups;
        catalogCursorRef.current = page.cursor;
        setCatalogGroups(nextGroups);
        setNextCatalogCursor(page.cursor);
      })
      .catch((error) => {
        if (catalogRequestGeneration.current === requestGeneration) {
          setCatalogMoreError(
            error instanceof Error ? error.message : "We couldn't load more internships right now.",
          );
        }
      })
      .finally(() => {
        if (catalogRequestGeneration.current === requestGeneration) {
          catalogRequestInFlight.current = false;
          setCatalogLoadingMore(false);
        }
      });
  };
  const acceptRefreshedToken = (requestId: number, value: string) => {
    if (privateRequestId.current !== requestId) return;
    acceptSessionToken(value);
  };
  const load = async () => {
    const requestToken = tokenRef.current;
    if (!requestToken) return;
    setPreferenceError(undefined);
    const requestId = privateRequestId.current;
    try {
      const apps = await authenticatedRead<{ applications: Application[] }>("/me/applications", { onToken: (value) => acceptRefreshedToken(requestId, value) });
      if (privateRequestId.current !== requestId || tokenRef.current !== requestToken) return;
      setApplications(apps.applications);
    } catch (error) {
      if (privateRequestId.current !== requestId || tokenRef.current !== requestToken) return;
      if (error instanceof ApiError && error.kind === "unauthorized") {
        finishLocalSignOut();
        await clearSession(requestToken);
        return;
      }
      setPreferenceError(
        error instanceof Error
          ? error.message
          : "Check your connection and try again.",
      );
    }
  };
  useEffect(() => {
    if (token) void load();
  }, [token]);
  useEffect(() => {
    if (!token || !preferences || legacyAlertMigrationToken.current === token) return;
    legacyAlertMigrationToken.current = token;
    const accountToken = token;
    const requestId = privateRequestId.current;
    void api<Preference>("/me/preferences", accountToken)
      .then(async (legacyPreferences) => {
        const updated = await migrateLegacyAccountAlerts({
          installation: preferences,
          legacyAccount: legacyPreferences,
          register: registerForJobAlerts,
          saveInstallation: (migration) => installationApi<Preference>("/preferences", {
            method: "PUT",
            body: JSON.stringify(migration),
          }),
          // Retire the account-owned flag only after the device token and
          // preferences are durably installation-owned. A failed retirement is
          // safe to retry on the next launch because every prior step is idempotent.
          retireLegacyAccount: () => api<Preference>("/me/preferences", accountToken, {
            method: "PUT",
            body: JSON.stringify({ alertsEnabled: false }),
          }),
        });
        if (updated && privateRequestId.current === requestId && tokenRef.current === accountToken) {
          setPreferences(updated);
        }
      })
      // Legacy migration is best-effort; the normal installation settings UI
      // remains available if the account session or push service is unavailable.
      .catch(() => undefined);
  }, [preferences, token]);
  useEffect(() => {
    if (!preferences?.onboardingComplete || launchLoaded || launchRequestToken.current === "installation") return;
    launchRequestToken.current = "installation";
    const requestId = ++launchRequestId.current;
    void installationApi<LaunchInbox>("/opening", { method: "POST" })
      .then((inbox) => {
        if (launchRequestId.current === requestId) {
          setLaunchInbox(inbox.total ? inbox : undefined);
          if (inbox.jobs.length) {
            setJobs((current) => [
              ...inbox.jobs,
              ...current.filter((job) => !inbox.jobs.some((newJob) => newJob.jobId === job.jobId)),
            ]);
          }
        }
      })
      // The normal feed remains useful if the launch-inbox check is unavailable.
      .catch(() => undefined)
      .finally(() => {
        if (launchRequestId.current === requestId) setLaunchLoaded(true);
      });
  }, [launchLoaded, preferences?.onboardingComplete]);
  const presentDestination = (destination: AppDestination) => {
    if (destination.kind === "queue") {
      setTab("queue");
      return;
    }
    if (destination.kind === "release") {
      setTab("roles");
      // An explicit notification tap must win over the automatic launch
      // inbox, including when that request already started during cold boot.
      launchRequestId.current += 1;
      launchRequestToken.current = "installation";
      setLaunchLoaded(true);
      void installationApi<{ jobs: Job[]; groups?: CatalogGroupDetails[]; total?: number }>(
        `/releases/${encodeURIComponent(destination.releaseId)}`,
      )
        .then((release) => {
          const openedAt = new Date().toISOString();
          setLaunchInbox({ jobs: release.jobs, groups: release.groups, total: release.total ?? release.jobs.length, hasMore: false, previousOpenedAt: null, openedAt });
          setJobs((current) => [...release.jobs, ...current.filter((job) => !release.jobs.some((released) => released.jobId === job.jobId))]);
        })
        .catch((error) => {
          if (error instanceof ApiError && error.kind === "offline") {
            pendingDestination.current = destination;
            setSessionRecoveryMessage(error.message);
            return;
          }
          Alert.alert("Could not open release", error instanceof Error ? error.message : "Please try again.");
        });
      return;
    }
    routedJobId.current = destination.jobId;
    detailVisible.current = true;
    setTab("roles");
    setSelectedJob(null);
    setSelectedMatchReasons(destination.reasons);
    setSelectedExclusionsApplied(destination.exclusionsApplied);
    setJobRouteState("loading");
    if (Platform.OS === "web" && typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (shouldPushJobHistory(url.searchParams.get("job"), destination.jobId)) {
        url.searchParams.set("job", destination.jobId);
        window.history.pushState({ jobId: destination.jobId }, "", url.toString());
      }
    }
    void api<Job>(`/jobs/${encodeURIComponent(destination.jobId)}`, "")
      .then((job) => {
        if (routedJobId.current !== destination.jobId) return;
        setSelectedJob(job);
        setJobRouteState("idle");
      })
      .catch((error) => {
        if (routedJobId.current !== destination.jobId) return;
        setJobRouteState(routeFailureState(error));
      });
  };
  const finishDetailDismissal = () => {
    if (!detailDismissalPending.current) return;
    detailDismissalPending.current = false;
    const destination = pendingDestination.current;
    pendingDestination.current = undefined;
    if (returnToGroupedRoles.current && !destination) setSelectedGroupVisible(Boolean(selectedGroupId));
    returnToGroupedRoles.current = false;
    if (destination) presentDestination(destination);
  };
  const dismissRoutedJob = () => {
    const wasVisible = detailVisible.current;
    routedJobId.current = undefined;
    detailVisible.current = false;
    setSelectedJob(null);
    setSelectedMatchReasons([]);
    setSelectedExclusionsApplied(false);
    setJobRouteState("idle");
    if (Platform.OS === "web" && typeof window !== "undefined" && wasVisible) {
      const url = new URL(window.location.href);
      if (url.searchParams.has("job")) {
        url.searchParams.delete("job");
        // If we pushed a job state, back will return to catalog without empty page.
        // Use back when possible, otherwise replace.
        if (window.history.state?.jobId) {
          window.history.back();
        } else {
          window.history.replaceState({}, "", url.toString());
        }
        // Prevent double-dismiss from popstate
        wasVisible && (detailDismissalPending.current = true);
        InteractionManager.runAfterInteractions(finishDetailDismissal);
        return;
      }
    }
    if (!wasVisible) return;
    detailDismissalPending.current = true;
    // React Native does not emit Modal.onDismiss on Android. Waiting for
    // interactions still gives the native modal time to release its window
    // before a queued notification presents the next role.
    if (Platform.OS !== "ios") {
      InteractionManager.runAfterInteractions(finishDetailDismissal);
    }
  };
  const openDestination = (destination: AppDestination | undefined, options: { allowActiveJob?: boolean } = {}) => {
    if (!destination) return;
    if (destination.kind === "queue") {
      if (detailVisible.current || detailDismissalPending.current) {
        pendingDestination.current = destination;
        if (detailVisible.current) dismissRoutedJob();
        return;
      }
      presentDestination(destination);
      return;
    }
    if (destination.kind === "release") {
      if (detailVisible.current || detailDismissalPending.current) {
        pendingDestination.current = destination;
        if (detailVisible.current) dismissRoutedJob();
        return;
      }
      presentDestination(destination);
      return;
    }
    const disposition = options.allowActiveJob
      ? "open"
      : jobOpenDisposition(routedJobId.current, destination.jobId, detailDismissalPending.current);
    if (disposition === "ignore") return;
    if (disposition === "replace") {
      pendingDestination.current = destination;
      if (detailVisible.current) dismissRoutedJob();
      return;
    }
    presentDestination(destination);
  };
  useEffect(() => {
    if (!token || detailVisible.current || detailDismissalPending.current || pendingDestination.current?.kind !== "release") return;
    const destination = pendingDestination.current;
    pendingDestination.current = undefined;
    presentDestination(destination);
  }, [token]);
  const openCatalogJob = (job: Job) => {
    if (detailDismissalPending.current) {
      pendingDestination.current = {
        kind: "job",
        jobId: job.jobId,
        reasons: [],
        exclusionsApplied: false,
      };
      return;
    }
    routedJobId.current = job.jobId;
    detailVisible.current = true;
    setSelectedMatchReasons([]);
    setSelectedExclusionsApplied(false);
    setJobRouteState("idle");
    setSelectedJob(job);
    if (Platform.OS === "web" && typeof window !== "undefined") {
      const url = new URL(window.location.href);
      if (shouldPushJobHistory(url.searchParams.get("job"), job.jobId)) {
        url.searchParams.set("job", job.jobId);
        window.history.pushState({ jobId: job.jobId }, "", url.toString());
      }
    }
  };
  const loadCatalogGroup = (groupId: string) => {
    const requestGeneration = groupRequestGuard.current.begin(groupId);
    setSelectedGroupLoading(true);
    setSelectedGroupError(undefined);
    const params = groupedCatalogParameters(catalogRequestState(catalogFilters, { query, dayZone }));
    params.delete("limit");
    void api<CatalogGroupDetails>(`/catalog/groups/${encodeURIComponent(groupId)}?${params.toString()}`, "")
      .then((details) => {
        if (!groupRequestGuard.current.isCurrent(requestGeneration, groupId)) return;
        setSelectedGroup(details);
      })
      .catch((error) => {
        if (!groupRequestGuard.current.isCurrent(requestGeneration, groupId)) return;
        setSelectedGroupError(error instanceof Error ? error.message : "We couldn't load these roles.");
      })
      .finally(() => {
        if (groupRequestGuard.current.isCurrent(requestGeneration, groupId)) setSelectedGroupLoading(false);
      });
  };
  const openCatalogGroup = (group: CatalogGroupRow, details?: CatalogGroupDetails) => {
    groupRequestGuard.current.invalidate();
    setSelectedGroupId(group.groupId);
    setSelectedGroupVisible(true);
    setSelectedGroup(details);
    if (details) {
      setSelectedGroupLoading(false);
      setSelectedGroupError(undefined);
    } else loadCatalogGroup(group.groupId);
  };
  const dismissCatalogGroup = () => {
    groupRequestGuard.current.invalidate();
    setSelectedGroupVisible(false);
    returnToGroupedRoles.current = false;
    setSelectedGroupId(undefined);
    setSelectedGroup(undefined);
    setSelectedGroupError(undefined);
    setSelectedGroupLoading(false);
  };
  const openGroupedRole = (job: Job) => {
    setSelectedGroupVisible(false);
    returnToGroupedRoles.current = true;
    openCatalogJob(job);
  };
  const retryRoutedJob = () => {
    const jobId = routedJobId.current;
    if (!jobId) return;
    openDestination(
      { kind: "job", jobId, reasons: selectedMatchReasons, exclusionsApplied: selectedExclusionsApplied },
      { allowActiveJob: true },
    );
  };
  useEffect(() => {
    const handleNotificationResponse = (response: Notifications.NotificationResponse) => {
      const destination = destinationFromNotification(response.notification.request.content.data);
      openDestination(destination);
      // Expo retains the last response across launches until it is cleared.
      // Once routed (or intentionally ignored), it must not reopen later.
      void Notifications.clearLastNotificationResponseAsync().catch(() => undefined);
    };
    const notificationSubscription = Notifications.addNotificationResponseReceivedListener(handleNotificationResponse);
    const urlSubscription = Linking.addEventListener("url", ({ url }) => openDestination(destinationFromUrl(url)));
    void Promise.allSettled([Notifications.getLastNotificationResponseAsync(), Linking.getInitialURL()]).then(([responseResult, urlResult]) => {
      if (responseResult.status === "fulfilled" && responseResult.value) {
        handleNotificationResponse(responseResult.value);
      }
      if (urlResult.status === "fulfilled" && urlResult.value) {
        openDestination(destinationFromUrl(urlResult.value));
      }
    });
    return () => {
      notificationSubscription.remove();
      urlSubscription.remove();
    };
  }, []);
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    // Handle initial ?job param and back/forward navigation
    const initialJobId = new URL(window.location.href).searchParams.get("job");
    if (initialJobId && !detailVisible.current) {
      openDestination({ kind: "job", jobId: initialJobId, reasons: [], exclusionsApplied: false });
    }
    const onPopState = () => {
      const url = new URL(window.location.href);
      const jobId = url.searchParams.get("job");
      if (!jobId && detailVisible.current) {
        dismissRoutedJob();
      } else if (jobId && routedJobId.current !== jobId) {
        openDestination({ kind: "job", jobId, reasons: [], exclusionsApplied: false });
      }
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);
  const catalogJobs = useMemo(() => {
    const newJobs = catalogFilters.jobStatus === "open" ? launchInbox?.jobs ?? [] : [];
    return [
      ...newJobs,
      ...jobs.filter((job) => !newJobs.some((newJob) => newJob.jobId === job.jobId)),
    ];
  }, [catalogFilters.jobStatus, jobs, launchInbox]);
  // The catalog's newness lane reads the same release the Roles tab shows, so
  // "new" means one thing across both surfaces.
  const newCatalogJobIds = useMemo(
    () => new Set(catalogFilters.jobStatus === "open" ? launchInbox?.jobs.map((job) => job.jobId) ?? [] : []),
    [catalogFilters.jobStatus, launchInbox],
  );
  const newSinceLabel = launchInbox ? launchInterval(launchInbox.previousOpenedAt) : "your last visit";
  const applicationStatuses = useMemo(
    () => new Map(applications.map((application) => [application.jobId, application.status])),
    [applications],
  );
  const applyQueue = useMemo(() => sortApplyQueue(applications), [applications]);
  const queuedJobIds = useMemo(() => new Set(applyQueue.map((item) => item.jobId)), [applyQueue]);
  const hideLocally = (job: Job) => {
    if (hiddenJobIds.has(job.jobId)) return;
    setHiddenJobIds((current) => {
      const updated = new Set(current).add(job.jobId);
      void responseCache.set(hiddenRolesCacheKey, [...updated]);
      return updated;
    });
    setHiddenFeedbackJob(job);
  };
  const undoHideLocally = () => {
    const job = hiddenFeedbackJob;
    if (!job) return;
    setHiddenJobIds((current) => {
      const updated = new Set(current);
      updated.delete(job.jobId);
      void responseCache.set(hiddenRolesCacheKey, [...updated]);
      return updated;
    });
    setHiddenFeedbackJob(undefined);
  };
  const restoreHiddenRole = (job: Job) => {
    setHiddenJobIds((current) => {
      const updated = new Set(current);
      updated.delete(job.jobId);
      void responseCache.set(hiddenRolesCacheKey, [...updated]);
      return updated;
    });
    if (hiddenFeedbackJob?.jobId === job.jobId) setHiddenFeedbackJob(undefined);
  };
  if (!ready)
    return <AppLoadingSkeleton />;
  if (sessionRecoveryMessage)
    return (
      <SessionRecoveryError
        message={sessionRecoveryMessage}
        onRetry={() => void recoverSession(true)}
        onContinueBrowsing={() => {
          void endSession();
        }}
      />
    );
  if (!token)
    return (
      <>
      <GuestExperience
        groups={catalogGroups}
        preferences={preferences ?? defaultPreference}
        onPreferencesChanged={setPreferences}
        routedJob={selectedJob}
        routedMatchReasons={selectedMatchReasons}
        routedExclusionsApplied={selectedExclusionsApplied}
        routeState={jobRouteState}
        onDismissRoute={dismissRoutedJob}
        onModalDismissedRoute={finishDetailDismissal}
        onRetryRoute={retryRoutedJob}
        filters={catalogFilters}
        onFiltersChange={setCatalogFilters}
        query={query}
        onQueryChange={setQuery}
        inbox={launchInbox}
        applicationStatuses={applicationStatuses}
        queuingJobIds={queuingJobIds}
        newJobIds={newCatalogJobIds}
        newSinceLabel={newSinceLabel}
        dayZone={dayZone}
        catalogInitialLoading={catalogInitialLoading}
        catalogError={catalogError}
        catalogLoadingMore={catalogLoadingMore}
        catalogMoreError={catalogMoreError}
        catalogReachedEnd={!nextCatalogCursor && !catalogInitialLoading && !catalogError}
        onLoadMore={() => loadNextCatalogPage()}
        onRetryLoadMore={() => loadNextCatalogPage(true)}
        onRetryCatalog={() => setCatalogRefresh((value) => value + 1)}
        hiddenJobIds={hiddenJobIds}
        hiddenFeedbackJob={hiddenFeedbackJob}
        hiddenJobs={catalogJobs.filter((job) => hiddenJobIds.has(job.jobId))}
        onRestoreHiddenRole={restoreHiddenRole}
        onHideLocally={hideLocally}
        onUndoHide={undoHideLocally}
        onOpenJob={openCatalogJob}
        onOpenGroup={openCatalogGroup}
        onSession={async (idToken) => {
          await sessionStorage.set(idToken);
          sessionRequestId.current += 1;
          acceptSessionToken(idToken);
        }}
      />
      <CatalogGroupSheet
        groupId={selectedGroupVisible ? selectedGroupId : undefined}
        details={selectedGroup}
        loading={selectedGroupLoading}
        error={selectedGroupError}
        onDismiss={dismissCatalogGroup}
        onRetry={() => selectedGroupId && loadCatalogGroup(selectedGroupId)}
        onOpenRole={openGroupedRole}
      />
      </>
    );
  if (!preferences && preferenceError)
    return (
      <AccountLoadError
        message={preferenceError}
        onRetry={() => {
          void recoverSession(true).then((result) => {
            if (result?.status === "authenticated") void load();
          });
        }}
        onSignOut={() => {
          void endSession();
        }}
      />
    );
  if (!preferences) return <AppLoadingSkeleton />;
  if (!preferences.onboardingComplete)
    return <Onboarding onDone={setPreferences} />;
  const dequeueOpenedApplication = (jobId: string) => {
    const queued = applications.find((item) => item.jobId === jobId && item.status === "saved" && item.queuedAt !== undefined);
    if (!queued) return;
    setApplications((current) => current.map((item) => {
      if (item.applicationId !== queued.applicationId) return item;
      const updated = { ...item };
      delete updated.queuedAt;
      return updated;
    }));
    // A requeue request can still be in flight when the user opens the
    // employer form. Defer the dequeue until that request has established the
    // application ID, otherwise its later response can put the role back in
    // the queue after the handoff.
    if (isPendingApplicationId(queued.applicationId) || pendingQueueIds.current.has(jobId)) {
      dequeueAfterSave.current.add(jobId);
      return;
    }
    void api<Application>(`/me/applications/${encodeURIComponent(queued.applicationId)}`, token, {
      method: "PATCH",
      body: JSON.stringify({ queued: false }),
    }).then((updated) => {
      setApplications((current) => current.map((item) => item.applicationId === updated.applicationId ? updated : item));
    }).catch((error) => {
      setApplications((current) => current.map((item) => item.applicationId === queued.applicationId ? queued : item));
      Alert.alert("Could not update queue", error instanceof Error ? error.message : "Please try again.");
    });
  };
  const openApplicationAndScheduleCheck = (job: Pick<Job, "jobId" | "applyUrl">) => {
    void api("/me/gmail/checks", token, {
      method: "POST",
      body: JSON.stringify({ jobId: job.jobId }),
    }).catch((error) => {
      console.warn("Could not schedule Gmail application check", error);
    });
    // Start the request before handing off to the system browser, which can
    // immediately background the native app and suspend later JavaScript work.
    void openOfficialApplication(job.applyUrl, preferences.applicationHandoff ?? "window", () => dequeueOpenedApplication(job.jobId));
  };
  const openQueueBulk = (targets: Array<{ jobId: string; applyUrl: string }>) => {
    if (Platform.OS !== "web") {
      const [first] = targets;
      if (first) openApplicationAndScheduleCheck(first);
      return;
    }
    let blocked = 0;
    for (const target of targets) {
      void api("/me/gmail/checks", token, {
        method: "POST",
        body: JSON.stringify({ jobId: target.jobId }),
      }).catch((error) => {
        console.warn("Could not schedule Gmail application check", error);
      });
      const applicationWindow = openWebApplication(target.applyUrl, preferences.applicationHandoff ?? "window");
      if (applicationWindow === null) blocked += 1;
      else {
        applicationWindow.opener = null;
        dequeueOpenedApplication(target.jobId);
      }
    }
    if (blocked > 0) {
      Alert.alert(
        "Pop-ups blocked",
        `Your browser blocked ${blocked} of ${targets.length} role pages. Allow pop-ups for this site, then try again.`,
      );
    }
  };
  const beginQueueTracking = (jobId: string): boolean => {
    if (pendingQueueIds.current.has(jobId)) return false;
    pendingQueueIds.current.add(jobId);
    setSavingJobIds((current) => new Set(current).add(jobId));
    return true;
  };
  const endQueueTracking = (jobId: string) => {
    pendingQueueIds.current.delete(jobId);
    setSavingJobIds((current) => {
      if (!current.has(jobId)) return current;
      const updated = new Set(current);
      updated.delete(jobId);
      return updated;
    });
  };
  const reconcileApplications = async (): Promise<Application[] | undefined> => {
    const requestId = privateRequestId.current;
    try {
      const apps = await authenticatedRead<{ applications: Application[] }>("/me/applications", { onToken: (value) => acceptRefreshedToken(requestId, value) });
      if (privateRequestId.current !== requestId) return undefined;
      setApplications(apps.applications);
      return apps.applications;
    } catch {
      return undefined;
    }
  };
  const dequeueAfterQueuedMutation = async (application: Application) => {
    if (!dequeueAfterSave.current.has(application.jobId)) return application;
    dequeueAfterSave.current.delete(application.jobId);
    const dequeued = await api<Application>(`/me/applications/${encodeURIComponent(application.applicationId)}`, token, {
      method: "PATCH",
      body: JSON.stringify({ queued: false }),
    });
    setApplications((current) => current.map((item) => item.applicationId === dequeued.applicationId ? dequeued : item));
    return dequeued;
  };
  const addToQueue = (job: Job, options?: { silent?: boolean }) => {
    const existing = applications.find((item) => item.jobId === job.jobId);
    if (existing && existing.status !== "saved") return;
    if (existing?.status === "saved" && existing.queuedAt !== undefined) return;
    if (!beginQueueTracking(job.jobId)) return;
    const timestamp = new Date().toISOString();
    const pendingId = `pending-${job.jobId}`;
    if (existing?.status === "saved") {
      setApplications((current) => current.map((item) => item.applicationId === existing.applicationId ? { ...item, queuedAt: item.queuedAt ?? timestamp } : item));
    } else {
      const optimistic: Application = { applicationId: pendingId, jobId: job.jobId, status: "saved", queuedAt: timestamp, createdAt: timestamp };
      setApplications((current) => (current.some((item) => item.jobId === job.jobId) ? current : [optimistic, ...current]));
    }
    void (async () => {
      try {
        if (existing?.status === "saved") {
          const requeued = await api<Application>(`/me/applications/${encodeURIComponent(existing.applicationId)}`, token, {
            method: "PATCH",
            body: JSON.stringify({ queued: true }),
          });
          setApplications((current) => current.map((item) => item.applicationId === requeued.applicationId ? requeued : item));
          await dequeueAfterQueuedMutation(requeued);
          return;
        }
        const created = await api<Application>("/me/applications", token, {
          method: "POST",
          body: JSON.stringify({ jobId: job.jobId, status: "saved", queued: true }),
        });
        setApplications((current) => [
          created,
          ...current.filter((item) => item.applicationId !== created.applicationId && item.applicationId !== pendingId && item.jobId !== created.jobId),
        ]);
        await dequeueAfterQueuedMutation(created);
        const alertSettings = preferences.alertSettings ?? defaultAlertSettings;
        if (preferences.alertsEnabled && alertSettings.applicationReminders) {
          void scheduleApplicationFollowUp(
            created.applicationId,
            `${job.title} at ${job.company}`,
            alertSettings.followUpDays,
          ).catch(() => undefined);
        }
      } catch (error) {
        dequeueAfterSave.current.delete(job.jobId);
        setApplications((current) => existing?.status === "saved"
          ? current.map((item) => item.applicationId === existing.applicationId ? existing : item)
          : current.filter((item) => item.applicationId !== pendingId));
        const apps = await reconcileApplications();
        const queued = apps?.some((item) => item.jobId === job.jobId && item.status === "saved" && item.queuedAt !== undefined) ?? false;
        if (!queued && !options?.silent) {
          Alert.alert(
            "Could not save role",
            error instanceof Error ? error.message : "Please try again.",
          );
        }
      } finally {
        endQueueTracking(job.jobId);
      }
    })();
  };
  const requeueApplication = (application: Application) => {
    if (application.status !== "saved" || application.queuedAt !== undefined) return;
    if (!beginQueueTracking(application.jobId)) return;
    const timestamp = new Date().toISOString();
    setApplications((current) => current.map((item) => item.applicationId === application.applicationId ? { ...item, queuedAt: timestamp } : item));
    void (async () => {
      try {
        const requeued = await api<Application>(`/me/applications/${encodeURIComponent(application.applicationId)}`, token, {
          method: "PATCH",
          body: JSON.stringify({ queued: true }),
        });
        setApplications((current) => current.map((item) => item.applicationId === requeued.applicationId ? requeued : item));
        await dequeueAfterQueuedMutation(requeued);
      } catch (error) {
        dequeueAfterSave.current.delete(application.jobId);
        setApplications((current) => current.map((item) => item.applicationId === application.applicationId ? application : item));
        const apps = await reconcileApplications();
        const queued = apps?.some((item) => item.applicationId === application.applicationId && item.queuedAt !== undefined) ?? false;
        if (!queued) Alert.alert("Could not update queue", error instanceof Error ? error.message : "Please try again.");
      } finally {
        endQueueTracking(application.jobId);
      }
    })();
  };
  const removeFromQueue = (job: Job) => {
    const app = applications.find((a) => a.jobId === job.jobId);
    if (!app || app.status !== "saved") return;
    if (!beginQueueTracking(job.jobId)) return;
    const previousIndex = applications.findIndex((a) => a.applicationId === app.applicationId);
    setApplications((current) => current.filter((item) => item.applicationId !== app.applicationId));
    void (async () => {
      try {
        await api(`/me/applications/${encodeURIComponent(app.applicationId)}`, token, { method: "DELETE" });
        void clearApplicationFollowUp(app.applicationId).catch(() => undefined);
      } catch (error) {
        setApplications((current) => {
          if (current.some((item) => item.applicationId === app.applicationId)) return current;
          const next = [...current];
          next.splice(Math.min(Math.max(previousIndex, 0), next.length), 0, app);
          return next;
        });
        const apps = await reconcileApplications();
        const stillSaved = apps?.some((item) => item.jobId === job.jobId && item.status === "saved") ?? true;
        if (stillSaved) Alert.alert("Could not unsave role", error instanceof Error ? error.message : "Please try again.");
      } finally {
        endQueueTracking(job.jobId);
      }
    })();
  };
  return (
    <SafeAreaView style={styles.screen}>
      <View style={[styles.appShell, usesNavigationRail && styles.appShellWide]}>
        {usesNavigationRail ? <TabNavigation active={tab} onChange={changeTab} rail badgeCount={applyQueue.length} /> : null}
        <View style={styles.appMain}>
          {tab === "roles" ? (
            <View style={styles.pageColumn}>
            {launchInbox ? (
              <LaunchInbox
                inbox={launchInbox}
                onOpen={openCatalogJob}
                onOpenGroup={openCatalogGroup}
                onViewAll={() => changeTab("catalog")}
                applicationStatuses={applicationStatuses}
                queuedJobIds={queuedJobIds}
                onAddToQueue={addToQueue}
                queuingJobIds={queuingJobIds}
                hiddenJobIds={hiddenJobIds}
                onHideLocally={hideLocally}
                onRemoveFromQueue={removeFromQueue}
                hiddenFeedbackJob={hiddenFeedbackJob}
                onUndoHide={undoHideLocally}
                queueCount={applyQueue.length}
                onOpenQueue={() => setQueueSheetVisible(true)}
              />
            ) : (
              <View style={styles.catalogUnavailable}>
                <EmptyState
                  eyebrow="New matches"
                  title="Nothing new right now."
                  description="Roles that match your alerts land here when they appear. Search the catalog for everything we track."
                />
                <ActionButton label="Browse the catalog" onPress={() => changeTab("catalog")} />
              </View>
            )}
            </View>
          ) : tab === "queue" ? (
            <View style={styles.pageColumn}>
            <Applications
              applications={applications}
              queue={applyQueue}
              jobs={catalogJobs}
              token={token}
              alertSettings={preferences.alertSettings ?? defaultAlertSettings}
              alertsEnabled={preferences.alertsEnabled}
              onChanged={() => void load()}
              onRequeueApplication={requeueApplication}
              queuingJobIds={queuingJobIds}
              onOpenOfficialApplication={openApplicationAndScheduleCheck}
              onBulkOpenQueue={openQueueBulk}
            />
            </View>
          ) : tab === "catalog" ? (
            <CatalogScreen
              groups={catalogGroups}
              query={query}
              onQueryChange={setQuery}
              filters={catalogFilters}
              onFiltersChange={setCatalogFilters}
              loading={catalogInitialLoading}
              error={catalogError}
              loadingMore={catalogLoadingMore}
              moreError={catalogMoreError}
              reachedEnd={!nextCatalogCursor && !catalogInitialLoading && !catalogError}
              onLoadMore={() => loadNextCatalogPage()}
              onRetryLoadMore={() => loadNextCatalogPage(true)}
              onRetry={() => setCatalogRefresh((value) => value + 1)}
              onOpenGroup={openCatalogGroup}
              onOpenRole={openCatalogJob}
              onAddToQueue={addToQueue}
              onHideLocally={hideLocally}
              onRemoveFromQueue={removeFromQueue}
              queuingJobIds={queuingJobIds}
              applicationStatuses={applicationStatuses}
              queuedJobIds={queuedJobIds}
              queueCount={applyQueue.length}
              onOpenQueue={() => setQueueSheetVisible(true)}
              queue={applyQueue}
              queueJobs={catalogJobs}
              onOpenQueuedRole={openApplicationAndScheduleCheck}
              onBulkOpenQueue={openQueueBulk}
              newJobIds={newCatalogJobIds}
              newSinceLabel={newSinceLabel}
              dayZone={dayZone}
              hiddenJobIds={hiddenJobIds}
              hiddenFeedbackJob={hiddenFeedbackJob}
              onUndoHide={undoHideLocally}
            />
          ) : (
            <View style={styles.pageColumn}>
            <Profile
              token={token}
              preferences={preferences}
              applications={applications}
              hiddenJobs={catalogJobs.filter((job) => hiddenJobIds.has(job.jobId))}
              onRestoreHiddenRole={restoreHiddenRole}
              onPreferencesChanged={(updated) => setPreferences(updated)}
              onSignOut={async () => {
                await endSession();
              }}
              onSignIn={() => undefined}
            />
            </View>
          )}
        </View>
        {!usesNavigationRail ? <TabNavigation active={tab} onChange={changeTab} badgeCount={applyQueue.length} /> : null}
      </View>
      <JobDetailSheet
        job={selectedJob}
        signedIn
        matchedReasons={selectedMatchReasons}
        exclusionsApplied={selectedExclusionsApplied}
        routeState={jobRouteState}
        onDismiss={dismissRoutedJob}
        onModalDismissed={finishDetailDismissal}
        onRetry={retryRoutedJob}
        onApply={(job) => {
          openApplicationAndScheduleCheck(job);
        }}
        onOpenListing={(job) => {
          void openOfficialApplication(job.applyUrl, preferences.applicationHandoff ?? "window");
        }}
        onAddToQueue={(job) => addToQueue(job)}
        isAddingToQueue={selectedJob ? queuingJobIds.has(selectedJob.jobId) : false}
        applicationStatus={selectedJob ? applicationStatuses.get(selectedJob.jobId) : undefined}
        isQueued={selectedJob ? queuedJobIds.has(selectedJob.jobId) : undefined}
        onRemoveFromQueue={removeFromQueue}
      />
      <CatalogGroupSheet
        groupId={selectedGroupVisible ? selectedGroupId : undefined}
        details={selectedGroup}
        loading={selectedGroupLoading}
        error={selectedGroupError}
        onDismiss={dismissCatalogGroup}
        onRetry={() => selectedGroupId && loadCatalogGroup(selectedGroupId)}
        onOpenRole={openGroupedRole}
      />
      {Platform.OS === "web" ? (
        <QueueSheet
          visible={queueSheetVisible}
          queue={applyQueue}
          jobs={catalogJobs}
          onOpen={openApplicationAndScheduleCheck}
          onBulkOpen={openQueueBulk}
          onViewQueue={() => changeTab("queue")}
          onDismiss={() => setQueueSheetVisible(false)}
        />
      ) : null}
    </SafeAreaView>
  );
}

function EmployerStatus({ state, reason }: { state: Parameters<typeof employerStateExplanation>[0]; reason?: string }) {
  const explanation = employerStateExplanation(state, reason);
  return (
    <View
      accessible
      accessibilityLabel={`${explanation.label}${explanation.reason ? `. Reason: ${explanation.reason}` : ""}${explanation.nextAction ? `. Next action: ${explanation.nextAction}` : ""}`}
      style={[styles.employerStatus, explanation.tone === "danger" && styles.employerStatusDanger, explanation.tone === "warning" && styles.employerStatusWarning, explanation.tone === "positive" && styles.employerStatusPositive]}
    >
      <Text style={styles.employerStatusLabel}>{explanation.label}</Text>
      {explanation.reason ? <Text style={styles.employerStatusText}>Reason: {explanation.reason}</Text> : null}
      {explanation.nextAction ? <Text style={styles.employerStatusText}>Next: {explanation.nextAction}</Text> : null}
    </View>
  );
}

function EmployerField({ label, value, onChangeText, placeholder, multiline = false }: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder: string;
  multiline?: boolean;
}) {
  return (
    <View style={styles.employerField}>
      <Text style={styles.inputLabel}>{label}</Text>
      <PlainTextInput
        accessibilityLabel={label}
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={colors.placeholder}
        multiline={multiline}
        style={[styles.employerInput, multiline && styles.employerInputMultiline]}
      />
    </View>
  );
}

function EmployerPortal({ initialSection }: { initialSection: EmployerWorkspaceSection }) {
  const { width } = useWindowDimensions();
  const [token, setToken] = useState<string>();
  const [sessionReady, setSessionReady] = useState(false);
  const [section, setSection] = useState(initialSection);
  const [organizations, setOrganizations] = useState<EmployerOrganization[]>([]);
  const [organization, setOrganization] = useState<EmployerOrganization>();
  const [members, setMembers] = useState<EmployerMember[]>([]);
  const [sources, setSources] = useState<EmployerSource[]>([]);
  const [proposals, setProposals] = useState<EmployerMetadataProposal[]>([]);
  const [submissions, setSubmissions] = useState<EmployerSubmission[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [featureUnavailable, setFeatureUnavailable] = useState(false);
  const [feedback, setFeedback] = useState<string>();
  const [challengeId, setChallengeId] = useState<string>();
  const [challengeToken, setChallengeToken] = useState<string>();
  const [claimName, setClaimName] = useState("");
  const [claimDomain, setClaimDomain] = useState("");
  const [inviteEmail, setInviteEmail] = useState("");
  const [invitationToken, setInvitationToken] = useState("");
  const [newInvitationToken, setNewInvitationToken] = useState<string>();
  const [sourceUrl, setSourceUrl] = useState("");
  const [proposalJobId, setProposalJobId] = useState("");
  const [proposalField, setProposalField] = useState("");
  const [proposalValue, setProposalValue] = useState("");
  const [submission, setSubmission] = useState({
    company: "", title: "", programType: "internship", discipline: "software engineering",
    location: "", workMode: "onsite", season: "", deadline: "rolling", deadlineTimezone: "",
    workAuthorization: "unknown", applicationUrl: "", privateReviewNote: "",
  });
  const wide = width >= 880;

  const loadWorkspace = async (preferredOrganizationId?: string) => {
    setLoading(true);
    setError(undefined);
    try {
      const readOptions = { onToken: setToken };
      const response = await employerApi.organizations(readOptions);
      setFeatureUnavailable(false);
      setOrganizations(response.organizations);
      const selected = response.organizations.find((candidate) => candidate.organizationId === preferredOrganizationId)
        ?? response.organizations.find((candidate) => candidate.organizationId === organization?.organizationId)
        ?? response.organizations[0];
      setOrganization(selected);
      if (!selected) {
        setMembers([]); setSources([]); setProposals([]); setSubmissions([]);
        return;
      }
      const [detail, memberResponse, invitationResponse, sourceResponse, proposalResponse, submissionResponse] = await Promise.all([
        employerApi.organization(selected.organizationId, readOptions), employerApi.members(selected.organizationId, readOptions), employerApi.invitations(selected.organizationId, readOptions),
        employerApi.sources(selected.organizationId, readOptions), employerApi.proposals(selected.organizationId, readOptions),
        employerApi.submissions(selected.organizationId, readOptions),
      ]);
      setOrganization(detail.organization);
      setMembers(detail.members ?? [...memberResponse.members, ...invitationResponse.invitations]);
      setSources(detail.sources ?? sourceResponse.sources);
      setProposals(detail.proposals ?? proposalResponse.proposals);
      setSubmissions(detail.submissions ?? submissionResponse.submissions);
      setFeatureUnavailable(false);
    } catch (loadError) {
      if (loadError instanceof ApiError && loadError.status === 404) {
        setFeatureUnavailable(true);
        setError("The employer workspace could not be reached.");
      } else {
        setError(loadError instanceof Error ? loadError.message : "The employer workspace could not be loaded.");
      }
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    void restoreSession().then((result) => {
      if (result.status === "authenticated") setToken(result.token);
    }).finally(() => setSessionReady(true));
  }, []);
  useEffect(() => {
    if (typeof window === "undefined") return;
    setInvitationToken(new URL(window.location.href).searchParams.get("invitation") ?? "");
  }, []);
  useEffect(() => { if (token) void loadWorkspace(); }, [token]);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handleHistory = () => setSection(employerRouteFromUrl(window.location.href) ?? "verification");
    window.addEventListener("popstate", handleHistory);
    return () => window.removeEventListener("popstate", handleHistory);
  }, []);
  const changeSection = (nextSection: EmployerWorkspaceSection) => {
    if (typeof window !== "undefined") window.history.pushState({}, "", `/employer/${nextSection}`);
    setSection(nextSection);
  };
  const perform = async <T,>(action: () => Promise<T>, success: string, onSuccess?: (result: T) => void) => {
    setBusy(true); setError(undefined); setFeedback(undefined);
    try {
      const result = await action();
      setFeedback(success);
      onSuccess?.(result);
      await loadWorkspace();
    } catch (actionError) {
      if (actionError instanceof ApiError && actionError.kind === "unauthorized") {
        setToken(undefined);
        setOrganization(undefined);
      }
      setError(actionError instanceof Error ? actionError.message : "That change could not be saved.");
    } finally { setBusy(false); }
  };

  if (!sessionReady) return <AppLoadingSkeleton />;
  if (!token) {
    return (
      <SafeAreaView style={styles.employerRoot}>
        <View style={styles.employerAuth}>
          <Text style={styles.employerWordmark}>Ntern for employers</Text>
          <Text style={styles.employerPageTitle}>Manage trusted role sources.</Text>
          <Text style={styles.employerIntro}>Sign in with your verified account to claim an organization, connect official sources, and submit early-career roles.</Text>
          <SignIn onSession={async (idToken) => { await sessionStorage.set(idToken); setToken(idToken); }} />
        </View>
      </SafeAreaView>
    );
  }

  const orgId = organization?.organizationId;
  const canManageMembers = organization?.role === "owner";
  const canVerify = organization?.role === "owner";
  const isVerified = organization?.verificationState === "verified";
  const verification = organization ? employerStateExplanation(organization.verificationState, organization.verificationReason) : undefined;
  const updateSubmission = (key: keyof typeof submission, value: string) => setSubmission((current) => ({ ...current, [key]: value }));
  return (
    <SafeAreaView style={styles.employerRoot}>
      <View style={[styles.employerShell, wide && styles.employerShellWide]}>
        <View style={[styles.employerNav, wide ? styles.employerNavWide : styles.employerNavCompact]} accessibilityRole="tablist">
          <View style={[styles.employerBrandBlock, !wide && styles.employerBrandBlockCompact]}>
            <Text style={styles.employerWordmark}>Ntern</Text>
            <Text style={styles.employerWorkspaceLabel}>Employer workspace</Text>
          </View>
          {employerWorkspaceSections.map((item) => (
            <TouchableOpacity
              key={item.id}
              accessibilityRole="tab"
              aria-selected={section === item.id}
              accessibilityHint={item.description}
              onPress={() => changeSection(item.id)}
              style={[styles.employerNavItem, section === item.id && styles.employerNavItemActive]}
            >
              <Text style={[styles.employerNavText, section === item.id && styles.employerNavTextActive]}>{item.label}</Text>
            </TouchableOpacity>
          ))}
          <TouchableOpacity accessibilityRole="button" onPress={() => void (async () => { await signOut(token); setToken(undefined); setOrganization(undefined); })()} style={styles.employerSignOut}>
            <Text style={styles.employerSignOutText}>Sign out</Text>
          </TouchableOpacity>
        </View>
        <ScrollView style={styles.employerMain} contentContainerStyle={styles.employerContent} keyboardShouldPersistTaps="handled">
          <Text accessibilityRole="header" style={styles.employerPageTitle}>{employerWorkspaceSections.find(({ id }) => id === section)?.label}</Text>
          <Text style={styles.employerIntro}>{employerWorkspaceSections.find(({ id }) => id === section)?.description}</Text>
          {loading ? <Text accessibilityRole="progressbar" style={styles.employerNotice}>Loading workspace…</Text> : null}
          {error ? <Text accessibilityRole="alert" style={[styles.employerNotice, styles.employerError]}>{error}</Text> : null}
          {feedback ? <Text accessibilityRole="alert" style={[styles.employerNotice, styles.employerSuccess]}>{feedback}</Text> : null}
          {featureUnavailable ? (
            <View style={styles.employerEvidence}>
              <Text style={styles.employerHelp}>The service may still be rolling out. Retry this request before contacting support.</Text>
              <TouchableOpacity accessibilityRole="button" accessibilityLabel="Retry loading the employer workspace"
                disabled={loading} onPress={() => void loadWorkspace()} style={styles.employerInlineAction}>
                <Text style={styles.employerInlineActionText}>{loading ? "Retrying…" : "Try again"}</Text>
              </TouchableOpacity>
            </View>
          ) : null}

          {organizations.length > 1 ? (
            <View style={styles.employerEvidence}>
              <Text style={styles.inputLabel}>Organization</Text>
              {organizations.map((candidate) => <TouchableOpacity key={candidate.organizationId} accessibilityRole="button"
                aria-selected={candidate.organizationId === organization?.organizationId}
                onPress={() => { setOrganization(candidate); void loadWorkspace(candidate.organizationId); }} style={styles.employerInlineAction}>
                <Text style={styles.employerInlineActionText}>{candidate.name}{candidate.organizationId === organization?.organizationId ? " · selected" : ""}</Text>
              </TouchableOpacity>)}
            </View>
          ) : null}

          {!organization && !loading && !featureUnavailable ? (
            <View style={styles.employerSection}>
              <Text accessibilityRole="header" style={styles.employerSectionTitle}>Accept an invitation</Text>
              <EmployerField label="Invitation token" value={invitationToken} onChangeText={setInvitationToken} placeholder="Paste the private invitation token" />
              <ActionButton label={busy ? "Accepting…" : "Accept invitation"} disabled={busy || !invitationToken.trim()} onPress={() => void perform(
                () => employerApi.acceptInvitation(token, invitationToken.trim()), "Invitation accepted.", () => setInvitationToken(""),
              )} />
              <Text accessibilityRole="header" style={styles.employerSectionTitle}>Claim your organization</Text>
              <Text style={styles.employerHelp}>Use the legal or public company name and its primary website domain.</Text>
              <EmployerField label="Organization name" value={claimName} onChangeText={setClaimName} placeholder="Acme" />
              <EmployerField label="Company domain" value={claimDomain} onChangeText={setClaimDomain} placeholder="acme.com" />
              <ActionButton label={busy ? "Submitting…" : "Submit claim"} disabled={busy || !claimName.trim() || !claimDomain.trim()} onPress={() => void perform(async () => {
                const response = await employerApi.claim(token, { name: claimName.trim(), domain: claimDomain.trim().toLowerCase() });
                setOrganization(response.organization);
              }, "Organization claim submitted.")} />
            </View>
          ) : null}

          {organization && section === "verification" ? (
            <View style={styles.employerSection}>
              <Text accessibilityRole="header" style={styles.employerSectionTitle}>{organization.name}</Text>
              <Text style={styles.employerHelp}>{organization.domain} · You are an {organization.role}.</Text>
              <EmployerStatus state={organization.verificationState} reason={organization.verificationReason} />
              {challengeToken ?? organization.challengeToken ? (
                <View style={styles.employerEvidence}>
                  <Text style={styles.inputLabel}>Verification token</Text>
                  <Text selectable style={styles.employerCode}>{challengeToken ?? organization.challengeToken}</Text>
                  <Text style={styles.employerHelp}>Publish this value in DNS TXT at _internnotifs-verification.{organization.domain}.</Text>
                </View>
              ) : null}
              {organization.verificationExpiresAt ? <Text style={styles.employerHelp}>Verification expires {new Date(organization.verificationExpiresAt).toLocaleDateString()}.</Text> : null}
              {!canVerify ? <Text style={styles.employerHelp}>Only an organization owner can manage verification.</Text> : organization.verificationState === "challenge-pending" && (challengeId ?? organization.activeChallengeId) && (challengeToken ?? organization.challengeToken) ? (
                <ActionButton label={busy ? "Checking…" : "Check verification"} disabled={busy || !(challengeToken ?? organization.challengeToken)} onPress={() => void perform(() => employerApi.verifyChallenge(token, orgId!, (challengeId ?? organization.activeChallengeId)!, (challengeToken ?? organization.challengeToken)!), "Challenge found and sent for review.")} />
              ) : organization.verificationState !== "verified" && organization.verificationState !== "review-pending" ? (
                <ActionButton label={busy ? "Starting…" : organization.activeChallengeId ? "Replace lost DNS challenge" : "Start DNS verification"} disabled={busy} onPress={() => void perform(() => employerApi.createChallenge(token, orgId!, "dns-txt"), "New DNS verification challenge created.", (result) => { setChallengeId(result.challenge.id); setChallengeToken(result.token ?? result.challenge.token); })} />
              ) : verification?.nextAction ? <Text style={styles.employerHelp}>{verification.nextAction}</Text> : null}
            </View>
          ) : null}

          {organization && section === "members" ? (
            <View style={styles.employerSection}>
              <Text style={styles.employerSectionTitle}>Accept another organization invitation</Text>
              <EmployerField label="Invitation token" value={invitationToken} onChangeText={setInvitationToken} placeholder="Paste the private invitation token" />
              <ActionButton label={busy ? "Accepting…" : "Accept invitation"} disabled={busy || !invitationToken.trim()} onPress={() => void perform(
                () => employerApi.acceptInvitation(token, invitationToken.trim()), "Invitation accepted.", () => setInvitationToken(""),
              )} />
              {members.map((member) => <View key={member.membershipId} style={[styles.employerRow, !wide && styles.employerRowCompact]}><View style={styles.employerRowCopy}><Text style={styles.employerRowTitle}>{member.email}</Text><Text style={styles.employerHelp}>{member.role}</Text>{canManageMembers && member.userId && member.role !== "owner" ? <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Remove ${member.email}`} onPress={() => void perform(() => employerApi.removeMember(token, orgId!, member.userId!), "Member removed.")} style={styles.employerInlineAction}><Text style={styles.employerInlineActionDanger}>Remove member</Text></TouchableOpacity> : null}</View><EmployerStatus state={member.state ?? "active"} reason={member.reason} /></View>)}
              {!members.length ? <Text style={styles.employerEmpty}>No members are listed yet.</Text> : null}
              {newInvitationToken ? <View style={styles.employerEvidence}><Text style={styles.inputLabel}>Private invitation link</Text><Text selectable style={styles.employerCode}>{typeof window !== "undefined" ? `${window.location.origin}/employer/members?invitation=${encodeURIComponent(newInvitationToken)}` : newInvitationToken}</Text><Text style={styles.employerHelp}>Share this link securely with the invited person. It is shown only once.</Text></View> : null}
              {canManageMembers ? <><Text style={styles.employerSectionTitle}>Invite an editor</Text><EmployerField label="Work email" value={inviteEmail} onChangeText={setInviteEmail} placeholder={`name@${organization.domain}`} /><ActionButton label={busy ? "Creating…" : "Create invitation"} disabled={busy || !inviteEmail.includes("@")} onPress={() => void perform(() => employerApi.inviteMember(token, orgId!, { email: inviteEmail.trim().toLowerCase(), role: "editor" }), "Invitation created.", (result) => setNewInvitationToken(result.token))} /></> : <Text style={styles.employerHelp}>Only an organization owner can manage invitations and members.</Text>}
            </View>
          ) : null}

          {organization && section === "sources" ? (
            <View style={styles.employerSection}>
              {sources.map((source) => <View key={source.sourceId} style={[styles.employerRow, !wide && styles.employerRowCompact]}><View style={styles.employerRowCopy}><Text style={styles.employerRowTitle}>{source.provider}</Text><Text selectable style={styles.employerUrl}>{source.url}</Text>{source.lastSuccessfulAt ? <Text style={styles.employerHelp}>Last healthy sync {new Date(source.lastSuccessfulAt).toLocaleString()}</Text> : null}</View><EmployerStatus state={source.state} reason={source.reason} /></View>)}
              {!sources.length ? <Text style={styles.employerEmpty}>No official sources connected.</Text> : null}
              <Text style={styles.employerSectionTitle}>Connect a source</Text>
              <Text style={styles.employerHelp}>Paste the exact HTTPS Greenhouse, Lever, Ashby, or reviewed structured careers URL. Ntern will not guess a board from a company name.</Text>
              <EmployerField label="Official source URL" value={sourceUrl} onChangeText={setSourceUrl} placeholder="https://boards.greenhouse.io/acme" />
              {!isVerified ? <Text style={styles.employerHelp}>Verify the organization before connecting a source.</Text> : null}
              <ActionButton label={busy ? "Connecting…" : "Connect source"} disabled={busy || !isVerified || !sourceUrl.startsWith("https://")} onPress={() => void perform(() => employerApi.connectSource(token, orgId!, sourceUrl), "Source submitted for review.")} />
            </View>
          ) : null}

          {organization && section === "metadata" ? (
            <View style={styles.employerSection}>
              {proposals.map((proposal) => <View key={proposal.proposalId} style={[styles.employerRow, !wide && styles.employerRowCompact]}><View style={styles.employerRowCopy}><Text style={styles.employerRowTitle}>{proposal.field}: {proposal.proposedValue}</Text><Text style={styles.employerHelp}>Role {proposal.jobId}{proposal.originalValue ? ` · Current: ${proposal.originalValue}` : ""}</Text></View><EmployerStatus state={proposal.state} reason={proposal.reason} /></View>)}
              {!proposals.length ? <Text style={styles.employerEmpty}>No metadata proposals yet.</Text> : null}
              <Text style={styles.employerSectionTitle}>Propose a field change</Text>
              <EmployerField label="Catalog role ID" value={proposalJobId} onChangeText={setProposalJobId} placeholder="role_…" />
              <EmployerField label="Field" value={proposalField} onChangeText={setProposalField} placeholder="applicationDeadline" />
              <EmployerField label="Proposed value" value={proposalValue} onChangeText={setProposalValue} placeholder="2026-10-15" />
              {!isVerified ? <Text style={styles.employerHelp}>Verify the organization before proposing metadata.</Text> : null}
              <ActionButton label={busy ? "Submitting…" : "Submit proposal"} disabled={busy || !isVerified || !proposalJobId.trim() || !proposalField.trim() || !proposalValue.trim()} onPress={() => void perform(() => employerApi.proposeMetadata(token, orgId!, proposalJobId, proposalField, proposalValue), "Metadata proposal submitted.")} />
            </View>
          ) : null}

          {organization && section === "submissions" ? (
            <View style={styles.employerSection}>
              {submissions.map((item) => <View key={item.submissionId} style={[styles.employerRow, !wide && styles.employerRowCompact]}><View style={styles.employerRowCopy}><Text style={styles.employerRowTitle}>{item.title}</Text>{item.updatedAt ? <Text style={styles.employerHelp}>Updated {new Date(item.updatedAt).toLocaleDateString()}</Text> : null}{item.state !== "closed" && item.state !== "rejected" ? <TouchableOpacity accessibilityRole="button" accessibilityLabel={`Close ${item.title}`} onPress={() => void perform(() => employerApi.closeSubmission(token, orgId!, item.submissionId), "Submission closed.")} style={styles.employerInlineAction}><Text style={styles.employerInlineActionText}>Close role</Text></TouchableOpacity> : null}</View><EmployerStatus state={item.state} reason={item.reason} /></View>)}
              {!submissions.length ? <Text style={styles.employerEmpty}>No direct submissions yet.</Text> : null}
              <Text style={styles.employerSectionTitle}>Submit a structured role</Text>
              <Text style={styles.employerHelp}>Provide catalog facts and the official application URL only. Do not paste a full job description.</Text>
              <View style={wide ? styles.employerFieldGrid : undefined}>
                {([['Company', 'company', organization.name], ['Role title', 'title', 'Software Engineering Intern'], ['Program type', 'programType', 'internship'], ['Technical discipline', 'discipline', 'software engineering'], ['Location', 'location', 'New York, NY'], ['Work mode', 'workMode', 'hybrid'], ['Season', 'season', 'Summer 2027'], ['Deadline or rolling', 'deadline', 'rolling'], ['Deadline timezone', 'deadlineTimezone', 'America/New_York'], ['Work authorization', 'workAuthorization', 'unknown'], ['Official application URL', 'applicationUrl', 'https://…']] as const).map(([label, key, placeholder]) => <View key={key} style={wide ? styles.employerGridItem : undefined}><EmployerField label={label} value={submission[key]} onChangeText={(value) => updateSubmission(key, value)} placeholder={placeholder} /></View>)}
              </View>
              <EmployerField label="Private review note (optional)" value={submission.privateReviewNote} onChangeText={(value) => updateSubmission("privateReviewNote", value)} placeholder="Context for the reviewer" multiline />
              {!isVerified ? <Text style={styles.employerHelp}>Verify the organization before submitting roles.</Text> : null}
              <ActionButton label={busy ? "Submitting…" : "Submit role for review"} disabled={busy || !isVerified || !submission.title.trim() || !submission.location.trim() || !submission.season.trim() || !submission.applicationUrl.startsWith("https://")} onPress={() => void perform(() => employerApi.submitRole(token, orgId!, { ...submission, company: submission.company || organization.name }), "Role submitted for review.")} />
            </View>
          ) : null}
        </ScrollView>
      </View>
    </SafeAreaView>
  );
}

export default function App() {
  const motionAllowed = useMotionAllowed();
  const employerSection = Platform.OS === "web" && typeof window !== "undefined"
    ? employerRouteFromUrl(window.location.href)
    : undefined;
  return (
    <MotionAllowedContext.Provider value={motionAllowed}>
      {employerSection ? <EmployerPortal initialSection={employerSection} /> : <AppContent />}
    </MotionAllowedContext.Provider>
  );
}

function GuestExperience({
  groups,
  preferences,
  onPreferencesChanged,
  routedJob,
  routedMatchReasons,
  routedExclusionsApplied,
  routeState,
  onDismissRoute,
  onModalDismissedRoute,
  onRetryRoute,
  filters,
  onFiltersChange,
  query,
  onQueryChange,
  inbox,
  applicationStatuses,
  queuingJobIds,
  newJobIds,
  newSinceLabel,
  dayZone,
  catalogInitialLoading,
  catalogError,
  catalogLoadingMore,
  catalogMoreError,
  catalogReachedEnd,
  onLoadMore,
  onRetryLoadMore,
  onRetryCatalog,
  hiddenJobIds,
  hiddenFeedbackJob,
  hiddenJobs,
  onRestoreHiddenRole,
  onHideLocally,
  onUndoHide,
  onOpenJob,
  onOpenGroup,
  onSession,
}: {
  groups: CatalogGroupRow[];
  preferences: Preference;
  onPreferencesChanged: (value: Preference) => void;
  routedJob: Job | null;
  routedMatchReasons: FilterMatchReason[];
  routedExclusionsApplied: boolean;
  routeState: JobRouteState;
  onDismissRoute: () => void;
  onModalDismissedRoute: () => void;
  onRetryRoute: () => void;
  filters: CatalogFilterValues;
  onFiltersChange: (next: CatalogFilterValues) => void;
  query: string;
  onQueryChange: (value: string) => void;
  inbox?: LaunchInbox;
  applicationStatuses: Map<string, string>;
  queuingJobIds: Set<string>;
  newJobIds?: Set<string>;
  newSinceLabel?: string;
  dayZone: string;
  catalogInitialLoading: boolean;
  catalogError?: string;
  catalogLoadingMore: boolean;
  catalogMoreError?: string;
  catalogReachedEnd: boolean;
  onLoadMore: () => void;
  onRetryLoadMore: () => void;
  onRetryCatalog: () => void;
  hiddenJobIds: Set<string>;
  hiddenFeedbackJob?: Job;
  hiddenJobs: Job[];
  onRestoreHiddenRole: (job: Job) => void;
  onHideLocally: (job: Job) => void;
  onUndoHide: () => void;
  onOpenJob: (job: Job) => void;
  onOpenGroup: (group: CatalogGroupRow) => void;
  onSession: (token: string) => void;
}) {
  const { width } = useWindowDimensions();
  const usesNavigationRail = width >= 700;
  const [tab, setTab] = useState<"roles" | "queue" | "catalog" | "profile">("catalog");
  const [showAccount, setShowAccount] = useState(false);
  const openAccount = () => {
    setShowAccount(true);
    if (Platform.OS === "web" && typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.set("auth", "signin");
      window.history.pushState({ auth: true }, "", url.toString());
    }
  };
  const closeAccount = () => {
    setShowAccount(false);
    if (Platform.OS === "web" && typeof window !== "undefined" && window.history.state?.auth) {
      window.history.back();
    } else if (Platform.OS === "web" && typeof window !== "undefined") {
      const url = new URL(window.location.href);
      url.searchParams.delete("auth");
      window.history.replaceState({}, "", url.toString());
    }
  };
  useEffect(() => {
    if (Platform.OS !== "web" || typeof window === "undefined") return;
    const onPopState = () => {
      const hasAuth = new URL(window.location.href).searchParams.has("auth") || Boolean(window.history.state?.auth);
      if (!hasAuth && showAccount) setShowAccount(false);
      if (hasAuth && !showAccount) setShowAccount(true);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, [showAccount]);
  return (
    <View style={styles.guestRoot}>
      <SafeAreaView
        style={[styles.screen, showAccount && Platform.OS === "web" && styles.hiddenScreen]}
        accessibilityElementsHidden={showAccount}
        importantForAccessibility={showAccount ? "no-hide-descendants" : "auto"}
      >
        <View style={[styles.appShell, usesNavigationRail && styles.appShellWide]}>
          {usesNavigationRail ? <TabNavigation active={tab} onChange={setTab} rail /> : null}
          <View style={styles.appMain}>
            <View
              style={[styles.appMain, tab !== "catalog" && styles.hiddenScreen]}
              pointerEvents={tab === "catalog" ? "auto" : "none"}
              accessibilityElementsHidden={tab !== "catalog"}
              importantForAccessibility={tab === "catalog" ? "auto" : "no-hide-descendants"}
            >
              <CatalogScreen
                groups={groups}
                query={query}
                onQueryChange={onQueryChange}
                filters={filters}
                onFiltersChange={onFiltersChange}
                loading={catalogInitialLoading}
                error={catalogError}
                loadingMore={catalogLoadingMore}
                moreError={catalogMoreError}
                reachedEnd={catalogReachedEnd}
                onLoadMore={onLoadMore}
                onRetryLoadMore={onRetryLoadMore}
                onRetry={onRetryCatalog}
                onOpenGroup={onOpenGroup}
                onOpenRole={onOpenJob}
                onAddToQueue={async () => { openAccount(); return false; }}
                onHideLocally={onHideLocally as unknown as (job: Job) => void}
                newJobIds={newJobIds}
                newSinceLabel={newSinceLabel}
                dayZone={dayZone}
                attentive={tab === "catalog"}
                hiddenJobIds={hiddenJobIds}
                hiddenFeedbackJob={hiddenFeedbackJob}
                onUndoHide={onUndoHide}
              />
            </View>
            {tab === "roles" ? (
              <View style={styles.pageColumn}>
              {inbox ? (
                <LaunchInbox
                  inbox={inbox}
                  onOpen={onOpenJob}
                  onOpenGroup={onOpenGroup}
                  onViewAll={() => setTab("catalog")}
                  applicationStatuses={applicationStatuses}
                  onAddToQueue={() => { openAccount(); }}
                  queuingJobIds={queuingJobIds}
                  hiddenJobIds={hiddenJobIds}
                  onHideLocally={onHideLocally}
                  hiddenFeedbackJob={hiddenFeedbackJob}
                  onUndoHide={onUndoHide}
                />
              ) : (
                <View style={styles.catalogUnavailable}>
                  <EmptyState
                    eyebrow="New matches"
                    title="Nothing new right now."
                    description="Roles that match your alerts land here when they appear. Search the catalog for everything we track."
                  />
                  <ActionButton label="Browse the catalog" onPress={() => setTab("catalog")} />
                </View>
              )}
              </View>
            ) : tab === "queue" ? (
              <View style={styles.pageColumn}>
                <AccountGate
                  feature="track applications"
                  onSignIn={openAccount}
                />
              </View>
            ) : tab === "profile" ? (
              <View style={styles.pageColumn}>
                <Profile
                  preferences={preferences}
                  applications={[]}
                  hiddenJobs={hiddenJobs}
                  onRestoreHiddenRole={onRestoreHiddenRole}
                  onPreferencesChanged={onPreferencesChanged}
                  onSignIn={openAccount}
                />
              </View>
            ) : null}
          </View>
          {!usesNavigationRail ? <TabNavigation active={tab} onChange={setTab} /> : null}
        </View>
        <JobDetailSheet
          job={routedJob}
          signedIn={false}
          matchedReasons={routedJob ? routedMatchReasons : []}
          exclusionsApplied={routedJob ? routedExclusionsApplied : false}
          routeState={routeState}
          onDismiss={onDismissRoute}
          onModalDismissed={onModalDismissedRoute}
          onRetry={onRetryRoute}
          onApply={(job) => {
            void openOfficialApplication(job.applyUrl);
          }}
          onOpenListing={(job) => {
            void openOfficialApplication(job.applyUrl);
          }}
          onAddToQueue={async () => { openAccount(); return false; }}
          onHideLocally={onHideLocally}
        />
      </SafeAreaView>
      {showAccount ? (
        <View style={styles.authOverlay}>
          <SignIn onSession={onSession} onBrowse={closeAccount} />
        </View>
      ) : null}
    </View>
  );
}

function AccountGate({
  feature,
  onSignIn,
}: {
  feature: string;
  onSignIn: () => void;
}) {
  return (
    <View style={styles.gate}>
      <Text style={styles.eyebrow}>Account required</Text>
      <Text style={styles.gateTitle}>Track the roles you want to pursue.</Text>
      <Text style={styles.intro}>
        Create a free account to {feature}. You can still browse every
        internship without one.
      </Text>
      <Text style={styles.gateBenefit}>What an account keeps</Text>
      <Text style={styles.gateBenefitCopy}>
        Your application queue and profile.
      </Text>
      <View style={styles.gateButton}>
        <ActionButton label="Sign in or create account" onPress={onSignIn} />
      </View>
    </View>
  );
}

function Onboarding({
  onDone,
}: {
  onDone: (preferences: Preference) => void;
}) {
  const [selected, setSelected] = useState<string[]>(["swe"]);
  const [keywords, setKeywords] = useState("");
  const [alertsRequested, setAlertsRequested] = useState(false);
  const [saving, setSaving] = useState(false);
  const [feedback, setFeedback] = useState<SaveFeedbackState>({ kind: "idle" });
  const toggle = (category: string) =>
    setSelected((current) =>
      current.includes(category)
        ? current.filter((item) => item !== category)
        : [...current, category],
    );
  const complete = async () => {
    setSaving(true);
    setFeedback({ kind: "saving", message: "Saving your alert settings…" });
    try {
      const registration = alertsRequested
        ? await registerForJobAlerts()
        : undefined;
      const preferences = await installationApi<Preference>("/preferences", {
        method: "PUT",
        body: JSON.stringify({
          filter: {
            includeCategories: selected,
            includeKeywords: keywords
              .split(",")
              .map((item) => item.trim())
              .filter(Boolean),
          },
          alertsEnabled: registration?.status === "registered",
          alertSettings: defaultAlertSettings,
          onboardingComplete: true,
        }),
      });
      // The saved response is sufficient to leave onboarding. Avoid waiting
      // for another request before showing the main app.
      onDone(preferences);
      if (registration?.status === "denied") showNotificationPermissionHelp();
      if (registration?.status === "unsupported") {
        Alert.alert(
          "Physical device required",
          "Finish setup without alerts here, then enable them from Profile on your iPhone or Android device.",
        );
      }
    } catch (error) {
      setFeedback({
        kind: "error",
        message:
          error instanceof Error
            ? error.message
            : "Please check your connection and try again.",
      });
    } finally {
      setSaving(false);
    }
  };
  return (
    <SafeAreaView style={styles.onboardingScreen}>
      <KeyboardAvoidingView
        style={styles.authKeyboard}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.onboardingContent}
          keyboardShouldPersistTaps="handled"
        >
          <Text style={styles.eyebrow}>Alerts</Text>
          <Text style={styles.hero}>Choose what to watch.</Text>
          <Text style={styles.intro}>
            Pick the roles worth interrupting you for. You can change this at
            any time.
          </Text>
          <Text style={styles.inputLabel}>Role categories</Text>
          <View style={styles.chips}>
            {categories.map((category) => (
              <TouchableOpacity
                key={category}
                accessibilityRole="checkbox"
                aria-checked={selected.includes(category)}
                style={[
                  styles.chip,
                  selected.includes(category) && styles.chipOn,
                ]}
                onPress={() => toggle(category)}
              >
                <Text
                  style={[
                    styles.chipLabel,
                    selected.includes(category) && styles.chipLabelOn,
                  ]}
                >
                  {category.toUpperCase()}
                </Text>
              </TouchableOpacity>
            ))}
          </View>
          <Text style={styles.inputLabel}>
            Specific keywords <Text style={styles.optionalLabel}>(optional)</Text>
          </Text>
          <PlainTextInput
            style={styles.formInput}
            value={keywords}
            onChangeText={setKeywords}
            accessibilityLabel="Specific keywords"
            placeholder="e.g. backend, robotics, research"
            placeholderTextColor={colors.placeholder}
          />
          <View style={styles.onboardingAlertRow}>
            <View style={styles.preferenceCopy}>
              <Text style={styles.preferenceTitle}>Enable job alerts</Text>
              <Text style={styles.muted}>
                Optional. We only ask for permission after you turn this on.
              </Text>
            </View>
            <Switch
              value={alertsRequested}
              onValueChange={setAlertsRequested}
              accessibilityLabel="Enable job alerts"
              trackColor={{ false: colors.border, true: colors.signal }}
              thumbColor={colors.onDark}
            />
          </View>
          <SaveFeedback state={feedback} onRetry={() => void complete()} />
          <ActionButton
            label={
              saving
                ? "Saving…"
                : alertsRequested
                  ? "Enable alerts and continue"
                  : "Continue without alerts"
            }
            disabled={saving}
            onPress={() => void complete()}
          />
          <Text style={styles.helperText}>
            {alertsRequested
              ? "We’ll ask for notification permission next."
              : "You can turn alerts on later in Profile."}
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
function QueueSheet({
  visible,
  queue,
  jobs,
  onOpen,
  onBulkOpen,
  onViewQueue,
  onDismiss,
}: {
  visible: boolean;
  queue: Application[];
  jobs: Job[];
  onOpen: (target: { jobId: string; applyUrl: string }) => void;
  onBulkOpen: (targets: Array<{ jobId: string; applyUrl: string }>) => void;
  onViewQueue: () => void;
  onDismiss: () => void;
}) {
  const next = nextAvailableQueueEntry(queue, jobs, 0);
  const nextJob = next ? resolveApplicationJob(next, jobs) : undefined;
  const queueSheet = useRoleSheetTransition(visible, onDismiss);
  const available = queue
    .map((item) => ({ item, target: queueEntryTarget(item, jobs) }))
    .filter((entry): entry is { item: Application; target: { jobId: string; applyUrl: string } } => entry.target !== undefined);
  return (
    <Modal visible={queueSheet.modalVisible} transparent animationType="none" onRequestClose={queueSheet.dismiss}>
      <Animated.View style={[styles.sheetOverlay, { opacity: queueSheet.dimOpacity }]}>
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Close apply queue" style={styles.sheetDismissArea} onPress={queueSheet.dismiss} />
        <Animated.View style={[styles.queueSheet, { transform: [{ translateY: queueSheet.sheetOffset }] }]}>
          <View style={styles.sheetHandle} />
          <Text style={styles.sheetTitle}>Apply queue · {queue.length}</Text>
          {queue.length === 0 ? (
            <Text style={styles.muted}>Add roles to the queue as you browse and they will wait here.</Text>
          ) : null}
          <ActionButton
            label={nextJob ? `Apply next: ${nextJob.title} at ${nextJob.company}` : "Apply next"}
            disabled={!next}
            onPress={() => { const target = next ? queueEntryTarget(next, jobs) : undefined; if (target) { onOpen(target); queueSheet.dismiss(); } }}
          />
          <QueueBulkButtons
            available={available.map((entry) => entry.target)}
            onOpenFirst={() => { const target = next ? queueEntryTarget(next, jobs) : undefined; if (target) { onOpen(target); queueSheet.dismiss(); } }}
            onBulkOpen={(targets) => { onBulkOpen(targets); queueSheet.dismiss(); }}
          />
          <ScrollView style={styles.queueSheetList}>
            {queue.map((item, index) => {
              const job = resolveApplicationJob(item, jobs);
              const target = queueEntryTarget(item, jobs);
              return (
                <View key={item.applicationId} style={styles.queueSheetRow}>
                  <View style={styles.queueSheetCopy}>
                    <View style={styles.queueSheetPositionBadge}>
                      <Text style={styles.queueSheetPosition}>{index + 1}</Text>
                    </View>
                    <View style={styles.queueSheetText}>
                      <Text style={styles.queueRowTitle} numberOfLines={1}>{job?.title ?? "Saved role"}</Text>
                      <Text style={styles.muted} numberOfLines={1}>{job?.company ?? ""}</Text>
                    </View>
                  </View>
                  {target ? (
                    <TouchableOpacity
                      accessibilityRole="button"
                      accessibilityLabel={`Open application for ${job?.title ?? "saved role"}${job?.company ? ` at ${job.company}` : ""}`}
                      onPress={() => { onOpen(target); queueSheet.dismiss(); }}
                      style={styles.queueOpenButton}
                    >
                      <Text style={styles.queueOpenButtonText}>Open</Text>
                      <Ionicons name="open-outline" size={15} color={colors.signal} />
                    </TouchableOpacity>
                  ) : (
                    <Text style={styles.muted}>Unavailable</Text>
                  )}
                </View>
              );
            })}
          </ScrollView>
          <ActionButton label="Open queue tab" variant="secondary" onPress={() => { onViewQueue(); queueSheet.dismiss(); }} />
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}
function Applications({
  applications,
  queue,
  jobs,
  token,
  alertSettings,
  alertsEnabled,
  onChanged,
  onRequeueApplication,
  queuingJobIds,
  onOpenOfficialApplication,
  onBulkOpenQueue,
}: {
  applications: Application[];
  queue: Application[];
  jobs: Job[];
  token: string;
  alertSettings: AlertSettings;
  alertsEnabled: boolean;
  onChanged: () => void;
  onRequeueApplication: (application: Application) => void;
  queuingJobIds: Set<string>;
  onOpenOfficialApplication: (job: Pick<Job, "jobId" | "applyUrl">) => void;
  onBulkOpenQueue?: (targets: Array<{ jobId: string; applyUrl: string }>) => void;
}) {
  const { width } = useWindowDimensions();
  const compactQueueActions = width < 600;
  const [detections, setDetections] = useState<GmailDetection[]>([]);
  const [detectionError, setDetectionError] = useState<string>();
  const [reviewingDetectionId, setReviewingDetectionId] = useState<string>();
  const loadDetections = () =>
    api<{ detections: GmailDetection[] }>("/me/gmail/detections", token)
      .then((response) => {
        setDetections(response.detections);
        setDetectionError(undefined);
      })
      .catch((error) => setDetectionError(error instanceof Error ? error.message : "Gmail detections could not be loaded."));
  useEffect(() => { void loadDetections(); }, [token]);
  const resolveDetection = async (detection: GmailDetection, action: "accept" | "dismiss", jobId?: string) => {
    setReviewingDetectionId(detection.detectionId);
    try {
      await api(`/me/gmail/detections/${encodeURIComponent(detection.detectionId)}/${action}`, token, {
        method: "POST",
        ...(jobId ? { body: JSON.stringify({ jobId }) } : {}),
      });
      setDetections((current) => current.filter((item) => item.detectionId !== detection.detectionId));
      if (action === "accept") onChanged();
    } catch (error) {
      Alert.alert("Could not update detection", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setReviewingDetectionId(undefined);
    }
  };
  const [queueIndex, setQueueIndex] = useState(0);
  useEffect(() => {
    if (queueIndex > queue.length - 1) setQueueIndex(0);
  }, [queue.length, queueIndex]);
  const queuePosition = Math.min(queueIndex, Math.max(queue.length - 1, 0));
  const nextQueued = nextAvailableQueueEntry(queue, jobs, queuePosition);
  const nextQueuedJob = nextQueued ? resolveApplicationJob(nextQueued, jobs) : undefined;
  const applyNext = () => {
    if (!nextQueued) return;
    const job = resolveApplicationJob(nextQueued, jobs);
    const applyUrl = job && "applyUrl" in job ? job.applyUrl : undefined;
    if (!job || !applyUrl) {
      Alert.alert("Application link unavailable", "The official application link for this role is no longer available.");
      return;
    }
    onOpenOfficialApplication({ jobId: job.jobId, applyUrl });
  };
  const skipQueued = () => {
    setQueueIndex((current) => Math.min(current + 1, Math.max(queue.length - 1, 0)));
  };
  const removeApplication = (item: Application) => {
    if (isPendingApplicationId(item.applicationId)) return;
    void (async () => {
      await api(`/me/applications/${encodeURIComponent(item.applicationId)}`, token, { method: "DELETE" });
      void clearApplicationFollowUp(item.applicationId).catch(() => undefined);
      onChanged();
    })().catch((error) =>
      Alert.alert("Could not remove application", error instanceof Error ? error.message : "Please try again."),
    );
  };
  const queuedIds = new Set(queue.map((entry) => entry.applicationId));
  const sections = applicationSections(applications, queue);
  const availableQueueTargets = queue
    .map((item) => queueEntryTarget(item, jobs))
    .filter((target): target is { jobId: string; applyUrl: string } => target !== undefined);
  useWebKeyboardShortcuts([
    { key: "n", onPress: applyNext, enabled: Boolean(nextQueuedJob) },
    { key: "s", onPress: skipQueued, enabled: queue.length > 1 },
    { key: "5", onPress: () => onBulkOpenQueue?.(selectBulkTargets(availableQueueTargets, 5)), enabled: availableQueueTargets.length >= 5 },
    { key: "t", onPress: () => onBulkOpenQueue?.(selectBulkTargets(availableQueueTargets, 10)), enabled: availableQueueTargets.length >= 10 },
    { key: "h", onPress: () => onBulkOpenQueue?.(selectBulkTargets(availableQueueTargets, "half")), enabled: availableQueueTargets.length >= 2 },
    { key: "a", onPress: () => onBulkOpenQueue?.(selectBulkTargets(availableQueueTargets, "all")), enabled: availableQueueTargets.length >= 2 },
  ]);
  const advanceApplicationStatus = (item: Application, nextStatus: Application["status"], roleName: string) => {
    if (isPendingApplicationId(item.applicationId)) return;
    void (async () => {
      const updated = await api<Application>(
        `/me/applications/${item.applicationId}`,
        token,
        {
          method: "PATCH",
          body: JSON.stringify({ status: nextStatus }),
        },
      );
      onChanged();
      if (!alertsEnabled || !alertSettings.applicationReminders) return;
      void notifyApplicationProgress(
        updated.applicationId,
        "Application progress updated",
        `${roleName} is now marked ${updated.status}.`,
      ).catch(() => undefined);
      if (["saved", "applied", "assessment", "interview"].includes(updated.status)) {
        void scheduleApplicationFollowUp(
          updated.applicationId,
          roleName,
          alertSettings.followUpDays,
        ).catch(() => undefined);
      } else {
        void clearApplicationFollowUp(updated.applicationId).catch(() => undefined);
      }
    })().catch((error) =>
      Alert.alert(
        "Could not update application",
        error instanceof Error ? error.message : "Please try again.",
      ),
    );
  };
  return (
    <View style={styles.queueScreen}>
    <SectionList
      style={styles.list}
      sections={sections}
      keyExtractor={(item) => item.applicationId}
      stickySectionHeadersEnabled={false}
      renderSectionHeader={({ section }) => (
        <View style={styles.queueSectionHeader}>
          <Text style={styles.queueSectionHeaderText}>{section.title}</Text>
        </View>
      )}
      contentContainerStyle={[styles.feedListContent, styles.applicationsListContent]}
      ListHeaderComponent={<>
        <PageHeading
          eyebrow="Apply queue"
          title="Roles to apply to"
          description="Queued roles wait here. Open one to apply; Ntern tracks its progress below."
        />
        {queue.length ? (
          <Text style={styles.queueCount}>{queue.length} {queue.length === 1 ? "role" : "roles"} in queue</Text>
        ) : null}
        {queue.length && onBulkOpenQueue ? (
          <QueueBulkButtons
            available={availableQueueTargets}
            onOpenFirst={() => { const [first] = availableQueueTargets; if (first) onOpenOfficialApplication(first); }}
            onBulkOpen={onBulkOpenQueue}
            shortcutMode="all"
          />
        ) : null}
        {detections.length ? (
          <View style={styles.gmailReviewSection}>
            <Text style={styles.sectionTitle}>Possibly applied</Text>
            <Text style={styles.muted}>Gmail found an application confirmation, but could not tell which recently opened role it belongs to.</Text>
            <TouchableOpacity
              accessibilityRole="button"
              accessibilityLabel="Why this application cannot be confirmed"
              onPress={() => Alert.alert(
                "Why we can’t confirm it",
                "The email confirms that you applied, but it does not include enough role details to distinguish between the applications you recently opened. Choose the matching role if you recognize it.",
              )}
              style={styles.gmailWhy}
            >
              <Text style={styles.gmailWhyText}>Why can’t this be confirmed?</Text>
            </TouchableOpacity>
            {detections.map((detection) => (
              <View key={detection.detectionId} style={styles.gmailReviewRow}>
                <Text style={styles.gmailSubject} numberOfLines={2}>{detection.subject || "Application confirmation"}</Text>
                <Text style={styles.gmailMetadata}>Gmail · {new Date(detection.receivedAt).toLocaleDateString()}</Text>
                {detection.candidates.map((candidate) => (
                  <TouchableOpacity
                    key={candidate.jobId}
                    accessibilityRole="button"
                    accessibilityLabel={`Confirm ${candidate.title} at ${candidate.company} was applied`}
                    disabled={reviewingDetectionId === detection.detectionId}
                    onPress={() => void resolveDetection(detection, "accept", candidate.jobId)}
                    style={styles.gmailCandidate}
                  >
                    <View style={styles.gmailCandidateCopy}>
                      <Text style={styles.preferenceTitle}>{candidate.title}</Text>
                      <Text style={styles.muted}>{candidate.company}</Text>
                    </View>
                    <Ionicons name="checkmark-circle-outline" size={24} color={colors.signal} />
                  </TouchableOpacity>
                ))}
                <TouchableOpacity
                  accessibilityRole="button"
                  disabled={reviewingDetectionId === detection.detectionId}
                  onPress={() => void resolveDetection(detection, "dismiss")}
                  style={styles.gmailDismiss}
                >
                  <Text style={styles.gmailDismissText}>None of these roles</Text>
                </TouchableOpacity>
              </View>
            ))}
          </View>
        ) : detectionError ? (
          <View style={styles.gmailReviewSection}>
            <Text style={styles.errorText}>{detectionError}</Text>
            <ActionButton compact variant="secondary" label="Try again" onPress={() => void loadDetections()} />
          </View>
        ) : null}
      </>}
      renderItem={({ item, index }) => {
        const job = resolveApplicationJob(item, jobs);
        const source = sourcePresentation(job?.sourceReferences ?? []);
        const nextStatus = nextApplicationStatuses[item.status] ?? "interview";
        const roleName = job
          ? `${job.title} at ${job.company}`
          : "Saved role";
        const availability = job && "availability" in job && job.availability
          ? job.availability
          : job?.open ? "available" : "closed";
        const unavailableReason = job && "unavailableReason" in job ? job.unavailableReason : undefined;
        const queueMutationPending = queuingJobIds.has(item.jobId);
        if (queuedIds.has(item.applicationId)) {
          const canOpen = availability === "available" && Boolean(job?.applyUrl);
          return (
            <View style={styles.queueCompactCard}>
              <View style={styles.queueCompactTop}>
                <View style={styles.queueSheetPositionBadge}>
                  <Text style={styles.queueSheetPosition}>{index + 1}</Text>
                </View>
                <View style={styles.queueCompactCopy}>
                  <Text style={styles.queueCompactCompany} numberOfLines={1}>{job?.company ?? "Saved role"}</Text>
                  <Text style={styles.queueCompactTitle} numberOfLines={2}>{job?.title ?? "Role details unavailable"}</Text>
                </View>
                {isPendingApplicationId(item.applicationId) || queueMutationPending ? (
                  <Text style={styles.queuePendingText}>Adding…</Text>
                ) : (
                  <TouchableOpacity
                    accessibilityRole="button"
                    accessibilityLabel={`Remove ${roleName} from queue`}
                    onPress={() => removeApplication(item)}
                    style={styles.queueCompactRemove}
                  >
                    <Ionicons name="remove-circle-outline" size={22} color={colors.muted} />
                  </TouchableOpacity>
                )}
              </View>
              {availability === "catalog-review" ? (
                <Text accessibilityRole="alert" style={styles.queueCompactUnavailable} numberOfLines={2}>
                  {unavailableReason ?? "Official application link under review."}
                </Text>
              ) : null}
              <View style={styles.queueCompactActions}>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`Open application for ${roleName}`}
                  disabled={!canOpen}
                  onPress={() => { if (job?.applyUrl) onOpenOfficialApplication({ jobId: job.jobId, applyUrl: job.applyUrl }); }}
                  style={[styles.queueCompactOpen, !canOpen && styles.queueCompactActionDisabled]}
                >
                  <Text style={styles.queueCompactOpenText}>{canOpen ? (compactQueueActions ? "Open" : "Open application") : "Unavailable"}</Text>
                  {canOpen ? <Ionicons name="open-outline" size={16} color={colors.onDark} /> : null}
                </TouchableOpacity>
                <TouchableOpacity
                  accessibilityRole="button"
                  accessibilityLabel={`Mark ${roleName} as ${nextStatus}`}
                  disabled={nextStatus === item.status || isPendingApplicationId(item.applicationId) || queueMutationPending}
                  onPress={() => advanceApplicationStatus(item, nextStatus, roleName)}
                  style={[styles.queueCompactProgress, (nextStatus === item.status || isPendingApplicationId(item.applicationId) || queueMutationPending) && styles.queueCompactActionDisabled]}
                >
                  <Ionicons name="checkmark-circle-outline" size={17} color={colors.signal} />
                  <Text style={styles.queueCompactProgressText}>{nextStatus === "applied" ? "Mark applied" : `Mark ${nextStatus}`}</Text>
                </TouchableOpacity>
              </View>
            </View>
          );
        }
        return (
          <View style={styles.card}>
            <Text style={styles.company}>{job?.company ?? "Saved role"}</Text>
            <Text style={styles.title}>{job?.title ?? "Role details unavailable"}</Text>
            {job ? <JobSource source={source} showIdentityUnconfirmed={job.postingIdentityStatus === "unconfirmed"} /> : null}
            <View style={styles.statusPill}>
              <Text style={styles.statusPillText}>{applicationStatusLabel(item.status, item.queuedAt)}</Text>
            </View>
            {item.detection?.source === "gmail" ? (
              <Text style={styles.gmailDetected}>Detected from Gmail · {new Date(item.detection.detectedAt).toLocaleDateString()}</Text>
            ) : null}
            {availability === "catalog-review" ? (
              <View accessibilityRole="alert" style={styles.catalogReviewNotice}>
                <Ionicons name="shield-checkmark-outline" size={20} color={colors.muted} />
                <Text style={styles.catalogReviewNoticeText}>
                  {unavailableReason ?? "Ntern couldn’t verify the official role page and is reviewing it."}
                </Text>
              </View>
            ) : null}
            {item.status === "saved" && isPendingApplicationId(item.applicationId) ? (
              <View style={styles.applicationActionGap}>
                <Text style={styles.queuePendingText}>Adding…</Text>
              </View>
            ) : null}
            {item.status === "saved" && item.queuedAt === undefined && !isPendingApplicationId(item.applicationId) ? (
              <View style={[styles.applicationActionGap, styles.applicationActionRow]}>
                <ActionButton
                  label={queueMutationPending ? "Adding…" : "Add to queue"}
                  compact
                  variant="secondary"
                  grow
                  disabled={queueMutationPending}
                  onPress={() => onRequeueApplication(item)}
                />
                <ActionButton
                  label="Remove"
                  compact
                  variant="secondary"
                  grow
                  disabled={queueMutationPending}
                  onPress={() => removeApplication(item)}
                />
              </View>
            ) : null}
            {availability === "available" && job?.applyUrl ? (
              <View style={styles.applicationActionGap}>
                <ApplyNowButton
                  label="Open official application"
                  hint="Opens the employer's official application in your browser."
                  onPress={() => onOpenOfficialApplication({ jobId: job.jobId, applyUrl: job.applyUrl! })}
                />
              </View>
            ) : null}
            <ActionButton
              label={
                nextStatus === item.status
                  ? "Status up to date"
                  : `Mark as ${nextStatus}`
              }
              compact
              variant="secondary"
              disabled={nextStatus === item.status || isPendingApplicationId(item.applicationId) || queueMutationPending}
              onPress={() => advanceApplicationStatus(item, nextStatus, roleName)}
            />
          </View>
        );
      }}
      ListEmptyComponent={
        <EmptyState
          eyebrow="Apply queue"
          title="Queue is clear."
          description="Add roles to the queue as you browse and they will work top to bottom here."
        />
      }
    />
      {queue.length ? (
        <View style={styles.queueActionBar}>
          <View style={styles.queueActionPrimary}>
            <ActionButton
              label={nextQueuedJob && !compactQueueActions ? `Apply next: ${nextQueuedJob.title} at ${nextQueuedJob.company}` : "Apply next"}
              disabled={!nextQueuedJob}
              onPress={applyNext}
              shortcut="N"
            />
          </View>
          {queue.length > 1 ? (
            <View style={styles.queueActionSecondary}>
              <ActionButton label="Skip" variant="secondary" onPress={skipQueued} shortcut="S" />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
}
function commaList(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}
function aliasesToText(aliases?: Record<string, string>) {
  return Object.entries(aliases ?? {})
    .map(([source, abbreviation]) => `${source} = ${abbreviation}`)
    .join("\n");
}
function aliasesFromText(value: string) {
  const aliases: Record<string, string> = {};
  for (const line of value
    .split("\n")
    .map((item) => item.trim())
    .filter(Boolean)) {
    const separator = line.indexOf("=");
    if (separator < 1)
      throw new Error(
        "Use one role abbreviation per line: full role = short label",
      );
    const source = line.slice(0, separator).trim();
    const abbreviation = line.slice(separator + 1).trim();
    if (!source || !abbreviation || abbreviation.length > 40)
      throw new Error(
        "Each role abbreviation needs a role and a short label (40 characters or fewer).",
      );
    aliases[source] = abbreviation;
  }
  return aliases;
}

function SettingsHome({
  onOpen,
}: {
  onOpen: (destination: Exclude<SettingsDestination, "home">) => void;
}) {
  return (
    <ScrollView style={styles.list} contentContainerStyle={styles.profileContent}>
      <Text style={[styles.hero, styles.profileHero]}>Settings</Text>
      <Text style={styles.intro}>
        Keep your application details separate from how Ntern works for you.
      </Text>
      <View style={styles.settingsList}>
        {settingsDestinations.map((destination) => (
          <TouchableOpacity
            key={destination.id}
            accessibilityRole="button"
            accessibilityLabel={destination.title}
            accessibilityHint={destination.accessibilityHint}
            onPress={() => onOpen(destination.id)}
            style={styles.settingsRow}
          >
            <View style={styles.settingsRowIcon}>
              <Ionicons name={destination.icon} size={22} color={colors.signal} />
            </View>
            <View style={styles.settingsRowCopy}>
              <Text style={styles.settingsRowTitle}>{destination.title}</Text>
              <Text style={styles.settingsRowDescription}>{destination.description}</Text>
            </View>
            <Ionicons name="chevron-forward" size={22} color={colors.muted} />
          </TouchableOpacity>
        ))}
      </View>
    </ScrollView>
  );
}

function Profile({
  token,
  preferences,
  applications,
  hiddenJobs,
  onRestoreHiddenRole,
  onPreferencesChanged,
  onSignOut,
  onSignIn,
}: {
  token?: string;
  preferences: Preference;
  applications: Application[];
  hiddenJobs: Job[];
  onRestoreHiddenRole: (job: Job) => void;
  onPreferencesChanged: (value: Preference) => void;
  onSignOut?: () => void;
  onSignIn: () => void;
}) {
  const { setting: dayZoneSetting, setSetting: setDayZoneSetting } = useDayZone();
  const [destination, setDestination] = useState<SettingsDestination>("home");
  const [profile, setProfile] = useState<Record<string, unknown>>({});
  const [loading, setLoading] = useState(true);
  const [gmailStatus, setGmailStatus] = useState<GmailStatus>({ connected: false });
  const [gmailLoading, setGmailLoading] = useState(false);
  const [gmailStatusError, setGmailStatusError] = useState<string>();
  const [includeCategories, setIncludeCategories] = useState<string[]>(
    preferences.filter.includeCategories ?? [],
  );
  const [excludeCategories, setExcludeCategories] = useState<string[]>(
    preferences.filter.excludeCategories ?? [],
  );
  const [includeKeywords, setIncludeKeywords] = useState(
    (preferences.filter.includeKeywords ?? []).join(", "),
  );
  const [excludeKeywords, setExcludeKeywords] = useState(
    (preferences.filter.excludeKeywords ?? []).join(", "),
  );
  const [alertsEnabled, setAlertsEnabled] = useState(preferences.alertsEnabled);
  const [notificationsBlocked, setNotificationsBlocked] = useState(false);
  const [includeEmployerCategories, setIncludeEmployerCategories] = useState<EmployerCategory[]>(
    preferences.filter.includeEmployerCategories ?? [],
  );
  const [excludeUsCitizenshipRequired, setExcludeUsCitizenshipRequired] = useState(
    preferences.filter.excludeUsCitizenshipRequired ?? false,
  );
  const [excludeAdvancedDegreeRequired, setExcludeAdvancedDegreeRequired] = useState(
    preferences.filter.excludeAdvancedDegreeRequired ?? false,
  );
  const [delivery, setDelivery] = useState<AlertSettings["delivery"]>(
    preferences.alertSettings?.delivery ?? defaultAlertSettings.delivery,
  );
  const [quietStart, setQuietStart] = useState(
    preferences.alertSettings?.quietHours?.start ?? "22:00",
  );
  const [quietEnd, setQuietEnd] = useState(
    preferences.alertSettings?.quietHours?.end ?? "08:00",
  );
  const [quietTimezone, setQuietTimezone] = useState(
    preferences.alertSettings?.quietHours?.timezone ?? "America/New_York",
  );
  const [applicationReminders, setApplicationReminders] = useState(
    preferences.alertSettings?.applicationReminders ?? true,
  );
  const [followUpDays, setFollowUpDays] = useState(
    String(preferences.alertSettings?.followUpDays ?? defaultAlertSettings.followUpDays),
  );
  const [applicationHandoff, setApplicationHandoff] = useState<ApplicationHandoff>(
    preferences.applicationHandoff ?? "window",
  );
  const [titleTemplate, setTitleTemplate] = useState(
    preferences.push?.titleTemplate ?? "",
  );
  const [descriptionTemplate, setDescriptionTemplate] = useState(
    preferences.push?.descriptionTemplate ?? "",
  );
  const [roleAliases, setRoleAliases] = useState(
    aliasesToText(preferences.push?.roleAbbreviations),
  );
  const [savingJobPreferences, setSavingJobPreferences] = useState(false);
  const [jobPreferenceFeedback, setJobPreferenceFeedback] = useState<SaveFeedbackState>({
    kind: "idle",
  });
  const [savingAppSettings, setSavingAppSettings] = useState(false);
  const [appSettingsFeedback, setAppSettingsFeedback] = useState<SaveFeedbackState>({
    kind: "idle",
  });
  const [savingProfile, setSavingProfile] = useState(false);
  const [profileFeedback, setProfileFeedback] = useState<SaveFeedbackState>({
    kind: "idle",
  });
  const [exportingData, setExportingData] = useState(false);
  const [exportFeedback, setExportFeedback] = useState<SaveFeedbackState>({ kind: "idle" });
  const [deletingAccount, setDeletingAccount] = useState(false);
  const draftRevisions = useRef<SettingsDraftRevisions>({
    jobPreferences: 0,
    appSettings: 0,
  });
  const syncedDraftRevisions = useRef<SettingsDraftRevisions>({
    jobPreferences: 0,
    appSettings: 0,
  });
  const markJobPreferencesDirty = () => {
    draftRevisions.current.jobPreferences += 1;
  };
  const markAppSettingsDirty = () => {
    draftRevisions.current.appSettings += 1;
  };
  useEffect(() => {
    if (!token) {
      setLoading(false);
      return;
    }
    void authenticatedRead<Record<string, unknown> | null>("/me/profile")
      .then((value) => setProfile(value ?? {}))
      .finally(() => setLoading(false));
  }, [token]);
  const loadGmailStatus = () => {
    if (!token) { setGmailStatus({ connected: false }); return Promise.resolve(); }
    return api<GmailStatus>("/me/gmail", token)
      .then((status) => { setGmailStatus(status); setGmailStatusError(undefined); })
      .catch((error) => setGmailStatusError(error instanceof Error ? error.message : "Gmail status could not be loaded."));
  };
  useEffect(() => { void loadGmailStatus(); }, [token]);
  useEffect(() => {
    const sync = settingsDraftSyncPlan(
      draftRevisions.current,
      syncedDraftRevisions.current,
    );
    if (sync.jobPreferences) {
      setIncludeCategories(preferences.filter.includeCategories ?? []);
      setExcludeCategories(preferences.filter.excludeCategories ?? []);
      setIncludeKeywords((preferences.filter.includeKeywords ?? []).join(", "));
      setExcludeKeywords((preferences.filter.excludeKeywords ?? []).join(", "));
      setAlertsEnabled(preferences.alertsEnabled);
      setIncludeEmployerCategories(preferences.filter.includeEmployerCategories ?? []);
      setExcludeUsCitizenshipRequired(preferences.filter.excludeUsCitizenshipRequired ?? false);
      setExcludeAdvancedDegreeRequired(preferences.filter.excludeAdvancedDegreeRequired ?? false);
      setDelivery(preferences.alertSettings?.delivery ?? defaultAlertSettings.delivery);
      setQuietStart(preferences.alertSettings?.quietHours?.start ?? "22:00");
      setQuietEnd(preferences.alertSettings?.quietHours?.end ?? "08:00");
      setQuietTimezone(
        preferences.alertSettings?.quietHours?.timezone ?? "America/New_York",
      );
    }
    if (sync.appSettings) {
      setApplicationReminders(
        preferences.alertSettings?.applicationReminders ?? true,
      );
      setFollowUpDays(
        String(preferences.alertSettings?.followUpDays ?? defaultAlertSettings.followUpDays),
      );
      setApplicationHandoff(preferences.applicationHandoff ?? "window");
      setTitleTemplate(preferences.push?.titleTemplate ?? "");
      setDescriptionTemplate(preferences.push?.descriptionTemplate ?? "");
      setRoleAliases(aliasesToText(preferences.push?.roleAbbreviations));
    }
  }, [preferences]);
  useEffect(() => {
    if (destination === "home") return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      setDestination("home");
      return true;
    });
    return () => subscription.remove();
  }, [destination]);
  if (destination === "home") return <SettingsHome onOpen={setDestination} />;
  if (loading && destination === "user-info") return <ProfileLoadingSkeleton />;
  const contact = profile.contact as
    | { name?: string; firstName?: string; lastName?: string; email?: string; phone?: string }
    | undefined;
  const updateContact = (next: Partial<NonNullable<typeof contact>>) =>
    setProfile((current) => {
      const currentContact = (current.contact as NonNullable<typeof contact> | undefined) ?? {};
      const updated = { ...currentContact, ...next };
      const fullName = [updated.firstName, updated.lastName]
        .map((value) => value?.trim())
        .filter(Boolean)
        .join(" ");
      return {
        ...current,
        contact: { ...updated, ...(fullName ? { name: fullName } : {}) },
      };
    });
  const toggleCategory = <T extends string,>(
    category: T,
    selected: T[],
    setter: (value: T[]) => void,
  ) =>
    setter(
      selected.includes(category)
        ? selected.filter((item) => item !== category)
        : [...selected, category],
    );
  const uploadResume = async () => {
    if (!token) throw new Error("Sign in to upload a résumé.");
    const result = await DocumentPicker.getDocumentAsync({
      type: [
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ],
    });
    if (result.canceled) return;
    const asset = result.assets[0];
    const response = await api<{
      document: { documentId: string };
      uploadUrl: string;
    }>("/me/documents", token, {
      method: "POST",
      body: JSON.stringify({
        fileName: asset.name,
        contentType: asset.mimeType ?? "application/pdf",
      }),
    });
    const file = await fetch(asset.uri);
    await uploadDocumentContent({
      uploadUrl: response.uploadUrl,
      token,
      contentType: asset.mimeType ?? "application/pdf",
      body: await file.blob(),
    }, {
      deleteMetadata: () => api(
        `/me/documents/${encodeURIComponent(response.document.documentId)}`,
        token,
        { method: "DELETE" },
      ),
    });
    setProfile((current) => ({
      ...current,
      resumeDocumentId: response.document.documentId,
    }));
    setProfileFeedback({
      kind: "success",
      message: "Résumé uploaded. Save your profile to keep it with your details.",
    });
  };
  const saveProfile = async () => {
    if (!token) return;
    setSavingProfile(true);
    setProfileFeedback({ kind: "saving", message: "Saving your profile…" });
    try {
      await api("/me/profile", token, {
        method: "PUT",
        body: JSON.stringify({
          ...profile,
          links: profile.links ?? {},
          education: profile.education ?? [],
          reusableAnswers: profile.reusableAnswers ?? {},
        }),
      });
      setProfileFeedback({ kind: "success", message: "Profile saved." });
    } catch (error) {
      setProfileFeedback({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Your profile could not be saved.",
      });
    } finally {
      setSavingProfile(false);
    }
  };
  const saveJobPreferences = async () => {
    const revisionBeingSaved = draftRevisions.current.jobPreferences;
    setSavingJobPreferences(true);
    setJobPreferenceFeedback({ kind: "saving", message: "Saving job preferences…" });
    try {
      if (alertsEnabled) {
        const registration = await registerForJobAlerts();
        if (registration.status !== "registered") {
          setNotificationsBlocked(registration.status === "denied");
          setJobPreferenceFeedback({
            kind: "error",
            message: registration.status === "denied"
              ? "Notifications are off for Ntern. Enable them in your device settings, then try again."
              : "Push alerts require a physical iPhone or Android device.",
          });
          return;
        }
      }
      setNotificationsBlocked(false);
      const updated = await installationApi<Preference>("/preferences", {
        method: "PUT",
        body: JSON.stringify(jobPreferencesPayload({
          filter: {
            includeCategories,
            includeKeywords: commaList(includeKeywords),
            excludeCategories,
            excludeKeywords: commaList(excludeKeywords),
            includeEmployerCategories,
            excludeUsCitizenshipRequired,
            excludeAdvancedDegreeRequired,
          },
          alertsEnabled,
          delivery,
          quietHours: {
            start: quietStart.trim(),
            end: quietEnd.trim(),
            timezone: quietTimezone.trim(),
          },
        })),
      });
      if (draftRevisions.current.jobPreferences === revisionBeingSaved) {
        syncedDraftRevisions.current.jobPreferences = revisionBeingSaved;
      }
      onPreferencesChanged(updated);
      setJobPreferenceFeedback({ kind: "success", message: "Job preferences saved." });
    } catch (error) {
      setJobPreferenceFeedback({
        kind: "error",
        message:
          error instanceof Error ? error.message : "Job preferences could not be saved.",
      });
    } finally {
      setSavingJobPreferences(false);
    }
  };
  const saveAppSettings = async () => {
    const revisionBeingSaved = draftRevisions.current.appSettings;
    setSavingAppSettings(true);
    setAppSettingsFeedback({ kind: "saving", message: "Saving app settings…" });
    try {
      const parsedFollowUpDays = Number(followUpDays);
      if (!Number.isInteger(parsedFollowUpDays) || parsedFollowUpDays < 1 || parsedFollowUpDays > 30) {
        throw new Error("Follow-up reminders must be scheduled 1 to 30 days after an update.");
      }
      const aliases = aliasesFromText(roleAliases);
      const push: PushPreferences = {
        ...(titleTemplate.trim()
          ? { titleTemplate: titleTemplate.trim() }
          : {}),
        ...(descriptionTemplate.trim()
          ? { descriptionTemplate: descriptionTemplate.trim() }
          : {}),
        ...(Object.keys(aliases).length ? { roleAbbreviations: aliases } : {}),
      };
      const updated = await installationApi<Preference>("/preferences", {
        method: "PUT",
        body: JSON.stringify(appSettingsPayload({
          applicationReminders,
          followUpDays: parsedFollowUpDays,
          applicationHandoff,
          push,
        })),
      });
      if (draftRevisions.current.appSettings === revisionBeingSaved) {
        syncedDraftRevisions.current.appSettings = revisionBeingSaved;
      }
      onPreferencesChanged(updated);
      setAppSettingsFeedback({ kind: "success", message: "App settings saved." });
    } catch (error) {
      setAppSettingsFeedback({
        kind: "error",
        message:
          error instanceof Error ? error.message : "App settings could not be saved.",
      });
    } finally {
      setSavingAppSettings(false);
    }
  };
  const exportMyData = async () => {
    if (!token || exportingData || deletingAccount) return;
    setExportingData(true);
    setExportFeedback({ kind: "saving", message: "Generating your complete export…" });
    try {
      const exported = await buildCompleteDataExport({
        fetchAccount: () => authenticatedRead<AccountExportResponse>("/me/export"),
        fetchInstallationPreferences: () => installationApi<Record<string, unknown>>("/preferences"),
      });
      await shareDataExport(exported);
      setExportFeedback({ kind: "success", message: "Your complete export is ready." });
    } catch (error) {
      const message = error instanceof DataExportFetchError || error instanceof SharingUnavailableError
        ? error.message
        : error instanceof Error ? error.message : "Your data export could not be generated.";
      setExportFeedback({ kind: "error", message });
    } finally {
      setExportingData(false);
    }
  };
  const deleteAccount = () =>
    token && !deletingAccount &&
    Alert.alert(
      "Delete account?",
      "This permanently deletes your profile, synced application tracking, uploaded documents, and sign-in account. Device alerts and app settings remain on this device.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete account",
          style: "destructive",
          onPress: () =>
            void (async () => {
              setDeletingAccount(true);
              try {
                await api("/me", token, { method: "DELETE" });
                await clearSession();
                onSignOut();
              } catch (error) {
                Alert.alert(
                  "Could not delete account",
                  error instanceof Error ? error.message : "Please try again.",
                );
              } finally {
                setDeletingAccount(false);
              }
            })()
        },
      ],
    );
  const connectGmail = async () => {
    if (!token || gmailLoading) return;
    setGmailLoading(true);
    try {
      const start = await api<{ authorizationUrl: string; returnUrl: string }>("/me/gmail/authorization", token, { method: "POST" });
      const result = await WebBrowser.openAuthSessionAsync(start.authorizationUrl, start.returnUrl);
      if (result.type === "success") {
        const callback = new URL(result.url);
        if (callback.searchParams.get("status") === "error") throw new Error(callback.searchParams.get("message") ?? "Gmail could not be connected.");
      }
      await loadGmailStatus();
    } catch (error) {
      Alert.alert("Could not connect Gmail", error instanceof Error ? error.message : "Please try again.");
    } finally {
      setGmailLoading(false);
    }
  };
  const retryGmailSync = async () => {
    if (!token || gmailLoading) return;
    setGmailLoading(true);
    try {
      await api("/me/gmail/sync", token, { method: "POST" });
      setGmailStatus((current) => ({ ...current, state: "syncing", error: undefined }));
    } catch (error) {
      Alert.alert("Could not retry Gmail sync", error instanceof Error ? error.message : "Please try again.");
    } finally { setGmailLoading(false); }
  };
  const disconnectGmail = async () => {
    if (!token || gmailLoading) return;
    setGmailLoading(true);
    try { await api("/me/gmail", token, { method: "DELETE" }); setGmailStatus({ connected: false }); }
    catch (error) { Alert.alert("Could not disconnect Gmail", error instanceof Error ? error.message : "Please try again."); }
    finally { setGmailLoading(false); }
  };
  const confirmDisconnectGmail = () => {
    if (!token || gmailLoading) return;
    const message = "This removes Gmail credentials, sync history, and pending detections. Existing application statuses stay in your list without Gmail evidence.";
    if (Platform.OS === "web" && typeof window !== "undefined") {
      if (window.confirm(`Disconnect Gmail?\n\n${message}`)) void disconnectGmail();
      return;
    }
    Alert.alert("Disconnect Gmail?", message, [
      { text: "Cancel", style: "cancel" },
      { text: "Disconnect Gmail", style: "destructive", onPress: () => void disconnectGmail() },
    ]);
  };
  const openLink = (label: string, value: string | undefined) => {
    if (!value || !/^https:\/\//.test(value)) {
      Alert.alert(
        `${label} unavailable`,
        "This release is missing its required public link. Please contact support.",
      );
      return;
    }
    void Linking.openURL(value).catch(() =>
      Alert.alert(`Could not open ${label.toLowerCase()}`),
    );
  };
  const previewTemplate = (template: string, fallback: string) =>
    (template.trim() || fallback)
      .replace(/\{shortTitle\}/g, "SWE")
      .replace(/\{title\}/g, "Software Engineering Intern")
      .replace(/\{company\}/g, "Northstar")
      .replace(/\{location\}/g, "New York, NY")
      .replace(/\{season\}/g, "Summer 2027")
      .replace(/\{compensation\}/g, "$52/hr")
      .replace(/\{compensationDetail\}/g, " · $52/hr")
      .replace(/\{focus\}/g, "Focus: Backend/API")
      .replace(/\{posted\}/g, "Today")
      .replace(/\{postedDetail\}/g, " · Employer posted: Today")
      .replace(/\{source\}/g, "Job board")
      .replace(/\{url\}/g, "ntern.app/roles/northstar");
  const previewDescription = (template: string, fallback: string) => {
    const selected = template.trim() || fallback;
    return previewTemplate(
      selected.includes("{source}") ? selected : `${selected}\nSource: {source}`,
      fallback,
    );
  };
  const accountActions = accountDataActionState(exportingData, deletingAccount);
  return (
    <ScrollView
      style={styles.list}
      contentContainerStyle={styles.profileContent}
      keyboardShouldPersistTaps="handled"
    >
      <TouchableOpacity
        accessibilityRole="button"
        accessibilityLabel="Back to settings"
        onPress={() => setDestination("home")}
        style={styles.settingsBack}
      >
        <Ionicons name="chevron-back" size={22} color={colors.signal} />
        <Text style={styles.settingsBackText}>Settings</Text>
      </TouchableOpacity>
      {destination === "app-account" ? (
        <>
          <Text style={[styles.hero, styles.profileHero]}>App & account</Text>
          <Text style={styles.intro}>
            Manage notification wording, privacy, and the app data stored on this device.
          </Text>
          {hiddenJobs.length ? (
            <>
              <Text style={styles.profileSectionLabel}>Hidden roles</Text>
              <Text style={styles.muted}>
                These roles are hidden only on this device.
              </Text>
              <View style={styles.hiddenRolesList}>
                {hiddenJobs.map((job) => (
                  <View key={job.jobId} style={styles.hiddenRoleRow}>
                    <View style={styles.hiddenRoleCopy}>
                      <Text style={styles.company}>{job.company}</Text>
                      <Text style={styles.hiddenRoleTitle} numberOfLines={2}>{job.title}</Text>
                    </View>
                    <ActionButton
                      compact
                      label="Restore"
                      onPress={() => onRestoreHiddenRole(job)}
                    />
                  </View>
                ))}
              </View>
              <View style={styles.spacer} />
            </>
          ) : null}
          {token && applications.length ? (
            <>
              <Text style={styles.profileSectionLabel}>Application data</Text>
              <Text style={styles.muted}>
                The raw application records Ntern keeps for this account.
              </Text>
              <View style={styles.applicationDataList}>
                {applications.map((item) => (
                  <View key={item.applicationId} style={styles.applicationDataRow}>
                    <Text selectable style={styles.applicationDataTitle}>
                      {`${applicationStatusLabel(item.status, item.queuedAt)} · ${item.job?.company ?? item.jobId} · ${item.job?.title ?? ""}`}
                    </Text>
                    <Text selectable style={styles.applicationDataMeta}>
                      {[
                        `jobId ${item.jobId}`,
                        item.createdAt ? `created ${item.createdAt}` : undefined,
                        item.queuedAt ? `queued ${item.queuedAt}` : undefined,
                        item.detection?.detectedAt ? `detected ${item.detection.detectedAt}` : undefined,
                      ].filter(Boolean).join(" · ")}
                    </Text>
                  </View>
                ))}
              </View>
              <View style={styles.spacer} />
            </>
          ) : null}
          <Text style={styles.profileSectionLabel}>Release calendar dates</Text>
          <Text style={styles.muted}>
            Which calendar the catalog's release days belong to. Alerts and release cards use UTC days.
          </Text>
          <ChoiceOption
            label="UTC"
            description="The same day for everyone reading the catalog."
            selected={dayZoneSetting === "utc"}
            onPress={() => setDayZoneSetting("utc")}
          />
          <ChoiceOption
            label="Device time"
            description={`Your own clock (${deviceTimeZone()}). A role that lands after local midnight counts as the next day.`}
            selected={dayZoneSetting === "device"}
            onPress={() => setDayZoneSetting("device")}
          />
          <View style={styles.spacer} />
        </>
      ) : null}
      {destination === "user-info" ? token ? (
        <>
      <Text style={[styles.hero, styles.profileHero]}>User info</Text>
      <Text style={styles.intro}>
        Add the details you want available when you apply. You stay in control of every form.
      </Text>
      <Text style={styles.profileSectionLabel}>Contact</Text>
      <Text style={styles.inputLabel}>First name</Text>
      <PlainTextInput
        style={styles.search}
        accessibilityLabel="First name"
        placeholder="First name"
        placeholderTextColor={colors.placeholder}
        value={contact?.firstName ?? ""}
        onChangeText={(firstName) => updateContact({ firstName })}
      />
      <Text style={styles.inputLabel}>Last name</Text>
      <PlainTextInput
        style={styles.search}
        accessibilityLabel="Last name"
        placeholder="Last name"
        placeholderTextColor={colors.placeholder}
        value={contact?.lastName ?? ""}
        onChangeText={(lastName) => updateContact({ lastName })}
      />
      <Text style={styles.inputLabel}>Email</Text>
      <PlainTextInput
        style={styles.search}
        accessibilityLabel="Email"
        placeholder="you@example.com"
        placeholderTextColor={colors.placeholder}
        value={contact?.email ?? ""}
        onChangeText={(email) => updateContact({ email })}
      />
      <Text style={styles.inputLabel}>Phone</Text>
      <PlainTextInput
        style={styles.search}
        accessibilityLabel="Phone"
        placeholder="Phone number"
        placeholderTextColor={colors.placeholder}
        keyboardType="phone-pad"
        value={contact?.phone ?? ""}
        onChangeText={(phone) => updateContact({ phone })}
      />
      <Text style={styles.inputLabel}>Location</Text>
      <PlainTextInput
        style={styles.search}
        accessibilityLabel="Location"
        placeholder="Location"
        placeholderTextColor={colors.placeholder}
        value={(profile.location as string) ?? ""}
        onChangeText={(location) => setProfile({ ...profile, location })}
      />
      <Text style={styles.inputLabel}>Work authorization</Text>
      <PlainTextInput
        style={styles.search}
        accessibilityLabel="Work authorization"
        placeholder="Work authorization"
        placeholderTextColor={colors.placeholder}
        value={(profile.workAuthorization as string) ?? ""}
        onChangeText={(workAuthorization) =>
          setProfile({ ...profile, workAuthorization })
        }
      />
      <ActionButton
        label={profile.resumeDocumentId ? "Replace résumé" : "Upload résumé"}
        variant="secondary"
        onPress={() => void uploadResume()}
      />
      <View style={styles.spacer} />
      <ActionButton
        label={savingProfile ? "Saving profile…" : "Save profile"}
        disabled={savingProfile}
        onPress={() => void saveProfile()}
      />
      <SaveFeedback state={profileFeedback} onRetry={() => void saveProfile()} />
      <View style={styles.spacer} />
        </>
      ) : (
        <AccountGate feature="store application details and a résumé" onSignIn={onSignIn} />
      ) : null}
      {destination === "job-preferences" ? (
        <>
      <Text style={[styles.hero, styles.profileHero]}>Job preferences</Text>
      <Text style={styles.intro}>
        Choose the roles you want to see and when you want to hear about them.
      </Text>
      <Text style={styles.profileSectionLabel}>Alerts and filters</Text>
      <Text style={styles.sectionTitle}>Job alerts</Text>
      <View style={styles.preferenceRow}>
        <View style={styles.preferenceCopy}>
          <Text style={styles.preferenceTitle}>Job alerts</Text>
          <Text style={styles.muted}>
            Turn delivery on or off for this device.
          </Text>
        </View>
        <Switch
          value={alertsEnabled}
          onValueChange={(value) => {
            markJobPreferencesDirty();
            setAlertsEnabled(value);
          }}
          accessibilityLabel="Job alerts"
          trackColor={{ false: colors.border, true: colors.signal }}
          thumbColor={colors.onDark}
        />
      </View>
      <Text style={styles.preferenceTitle}>Company type</Text>
      <Text style={styles.muted}>
        Limit alerts to the kinds of companies you want to follow. Leave all three off for every company.
      </Text>
      <View style={styles.chips}>
        {(["faang", "startup", "normal"] as EmployerCategory[]).map((category) => (
          <TouchableOpacity
            key={`employer-${category}`}
            accessibilityRole="checkbox"
            aria-checked={includeEmployerCategories.includes(category)}
            style={[styles.chip, includeEmployerCategories.includes(category) && styles.chipOn]}
            onPress={() => {
              markJobPreferencesDirty();
              toggleCategory(category, includeEmployerCategories, setIncludeEmployerCategories);
            }}
          >
            <Text style={[styles.chipLabel, includeEmployerCategories.includes(category) && styles.chipLabelOn]}>
              {employerCategoryLabels[category]}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.preferenceTitle}>Requirements to avoid</Text>
      <View style={styles.preferenceRow}>
        <View style={styles.preferenceCopy}>
          <Text style={styles.preferenceTitle}>U.S. citizenship required</Text>
          <Text style={styles.muted}>Hide roles whose source explicitly requires U.S. citizenship.</Text>
        </View>
        <Switch
          value={excludeUsCitizenshipRequired}
          onValueChange={(value) => {
            markJobPreferencesDirty();
            setExcludeUsCitizenshipRequired(value);
          }}
          accessibilityLabel="Hide roles requiring U.S. citizenship"
          trackColor={{ false: colors.border, true: colors.signal }}
          thumbColor={colors.onDark}
        />
      </View>
      <View style={styles.preferenceRow}>
        <View style={styles.preferenceCopy}>
          <Text style={styles.preferenceTitle}>Advanced degree required</Text>
          <Text style={styles.muted}>Hide roles marked for a master’s, PhD, or MBA.</Text>
        </View>
        <Switch
          value={excludeAdvancedDegreeRequired}
          onValueChange={(value) => {
            markJobPreferencesDirty();
            setExcludeAdvancedDegreeRequired(value);
          }}
          accessibilityLabel="Hide roles requiring an advanced degree"
          trackColor={{ false: colors.border, true: colors.signal }}
          thumbColor={colors.onDark}
        />
      </View>
      <Text style={styles.preferenceTitle}>Delivery timing</Text>
      <View style={styles.choiceGroup} accessibilityRole="radiogroup">
        <ChoiceOption
          label="Immediate"
          description="Receive matching roles as they are found."
          selected={delivery === "immediate"}
          onPress={() => {
            markJobPreferencesDirty();
            setDelivery("immediate");
          }}
        />
        <ChoiceOption
          label="Daily digest"
          description="Review matching roles together once a day."
          selected={delivery === "daily-digest"}
          onPress={() => {
            markJobPreferencesDirty();
            setDelivery("daily-digest");
          }}
        />
      </View>
      <Text style={styles.preferenceTitle}>Quiet hours</Text>
      <Text style={styles.muted}>
        We’ll hold alerts during this window and deliver them afterward.
      </Text>
      <View style={styles.timeRow}>
        <View style={styles.timeField}>
          <Text style={styles.inputLabel}>Start</Text>
          <PlainTextInput
            style={styles.search}
            accessibilityLabel="Quiet hours start"
            value={quietStart}
            onChangeText={(value) => {
              markJobPreferencesDirty();
              setQuietStart(value);
            }}
            placeholder="22:00"
            placeholderTextColor={colors.placeholder}
            autoCapitalize="none"
          />
        </View>
        <View style={styles.timeField}>
          <Text style={styles.inputLabel}>End</Text>
          <PlainTextInput
            style={styles.search}
            accessibilityLabel="Quiet hours end"
            value={quietEnd}
            onChangeText={(value) => {
              markJobPreferencesDirty();
              setQuietEnd(value);
            }}
            placeholder="08:00"
            placeholderTextColor={colors.placeholder}
            autoCapitalize="none"
          />
        </View>
      </View>
      <Text style={styles.inputLabel}>Timezone</Text>
      <PlainTextInput
        style={styles.search}
        accessibilityLabel="Quiet hours timezone"
        value={quietTimezone}
        onChangeText={(value) => {
          markJobPreferencesDirty();
          setQuietTimezone(value);
        }}
        placeholder="America/New_York"
        placeholderTextColor={colors.placeholder}
        autoCapitalize="none"
      />
      <Text style={styles.preferenceTitle}>Include role categories</Text>
      <View style={styles.chips}>
        {categories.map((category) => (
          <TouchableOpacity
            key={`include-${category}`}
            style={[
              styles.chip,
              includeCategories.includes(category) && styles.chipOn,
            ]}
            accessibilityRole="checkbox"
            aria-checked={includeCategories.includes(category)}
            onPress={() => {
              markJobPreferencesDirty();
              toggleCategory(category, includeCategories, setIncludeCategories);
            }}
          >
            <Text
              style={[
                styles.chipLabel,
                includeCategories.includes(category) && styles.chipLabelOn,
              ]}
            >
              {category.toUpperCase()}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.inputLabel}>Include keywords</Text>
      <PlainTextInput
        style={styles.search}
        accessibilityLabel="Include keywords"
        value={includeKeywords}
        onChangeText={(value) => {
          markJobPreferencesDirty();
          setIncludeKeywords(value);
        }}
        placeholder="Include keywords, comma separated"
        placeholderTextColor={colors.placeholder}
      />
      <Text style={styles.preferenceTitle}>Exclude role categories</Text>
      <View style={styles.chips}>
        {categories.map((category) => (
          <TouchableOpacity
            key={`exclude-${category}`}
            style={[
              styles.chip,
              excludeCategories.includes(category) && styles.chipExclude,
            ]}
            accessibilityRole="checkbox"
            aria-checked={excludeCategories.includes(category)}
            onPress={() => {
              markJobPreferencesDirty();
              toggleCategory(category, excludeCategories, setExcludeCategories);
            }}
          >
            <Text
              style={[
                styles.chipLabel,
                excludeCategories.includes(category) && styles.chipLabelExclude,
              ]}
            >
              {category.toUpperCase()}
            </Text>
          </TouchableOpacity>
        ))}
      </View>
      <Text style={styles.inputLabel}>Exclude keywords</Text>
      <PlainTextInput
        style={styles.search}
        accessibilityLabel="Exclude keywords"
        value={excludeKeywords}
        onChangeText={(value) => {
          markJobPreferencesDirty();
          setExcludeKeywords(value);
        }}
        placeholder="Exclude keywords, comma separated"
        placeholderTextColor={colors.placeholder}
      />
      <ActionButton
        label={savingJobPreferences ? "Saving…" : "Save job preferences"}
        disabled={savingJobPreferences}
        onPress={() => void saveJobPreferences()}
      />
      <SaveFeedback
        state={jobPreferenceFeedback}
        onRetry={() => void saveJobPreferences()}
      />
      {notificationsBlocked ? (
        <>
          <View style={styles.buttonGap} />
          <ActionButton label="Open notification settings" variant="secondary" onPress={openAppSettings} />
        </>
      ) : null}
      <View style={styles.spacer} />
        </>
      ) : null}
      {destination === "app-account" ? (
        <>
      <Text style={styles.sectionTitle}>Gmail application detection</Text>
      <Text style={styles.muted}>
        Optional. After you tap Apply, Ntern checks Gmail for that role after 5 minutes, 10 minutes, 30 minutes, and 24 hours. It reads the sender, subject, date, labels, and a limited portion of the message text to confirm the employer and role. Message text is not stored, attachments are not processed, and Gmail data is never used for AI or model training.
      </Text>
      {token ? gmailStatus.connected ? (
        <View style={styles.gmailConnection}>
          <View style={styles.gmailConnectionHeading}>
            <Ionicons name={gmailStatus.state === "error" ? "alert-circle-outline" : "checkmark-circle"} size={24} color={gmailStatus.state === "error" ? colors.danger : colors.success} />
            <View style={styles.gmailConnectionCopy}>
              <Text style={styles.preferenceTitle}>{gmailStatus.email}</Text>
              <Text style={styles.muted}>
                {gmailStatus.state === "syncing" ? "Checking Gmail…" : gmailStatus.lastSuccessfulSync ? `Last checked ${new Date(gmailStatus.lastSuccessfulSync).toLocaleString()}` : "Connected"}
              </Text>
            </View>
          </View>
          {gmailStatus.error ? <Text style={styles.errorText}>{gmailStatus.error.message}</Text> : null}
          {gmailStatus.error?.retryable ? <ActionButton compact variant="secondary" label={gmailLoading ? "Retrying…" : "Retry sync"} disabled={gmailLoading} onPress={() => void retryGmailSync()} /> : null}
          <View style={styles.buttonGap} />
          <ActionButton variant="danger" label="Disconnect Gmail" disabled={gmailLoading} onPress={confirmDisconnectGmail} />
        </View>
      ) : (
        <>
          {gmailStatusError ? <Text style={styles.errorText}>{gmailStatusError}</Text> : null}
          <ActionButton label={gmailLoading ? "Connecting…" : "Connect Gmail"} disabled={gmailLoading} onPress={() => void connectGmail()} />
        </>
      ) : (
        <AccountGate feature="detect application confirmations from Gmail" onSignIn={onSignIn} />
      )}
      <View style={styles.spacer} />
      <Text style={styles.profileSectionLabel}>Notifications</Text>
      <Text style={styles.preferenceTitle}>Notification wording</Text>
      <Text style={styles.muted}>
        Supported placeholders: {pushPlaceholders.join(", ")}.
      </Text>
      <Text style={styles.inputLabel}>Notification title</Text>
      <PlainTextInput
        style={styles.search}
        accessibilityLabel="Notification title"
        placeholder="Title: {shortTitle} — {company}"
        placeholderTextColor={colors.placeholder}
        value={titleTemplate}
        onChangeText={(value) => {
          markAppSettingsDirty();
          setTitleTemplate(value);
        }}
      />
      <Text style={styles.inputLabel}>Notification description</Text>
      <PlainTextInput
        style={[styles.search, styles.multiline]}
        accessibilityLabel="Notification description"
        placeholder="Description: {location} · {season}\nSource: {source}\n{url}"
        placeholderTextColor={colors.placeholder}
        value={descriptionTemplate}
        onChangeText={(value) => {
          markAppSettingsDirty();
          setDescriptionTemplate(value);
        }}
        multiline
      />
      <Text style={styles.inputLabel}>Role abbreviations</Text>
      <PlainTextInput
        style={[styles.search, styles.multiline]}
        accessibilityLabel="Role abbreviations"
        placeholder="Role abbreviations, one per line: software engineer = SWE"
        placeholderTextColor={colors.placeholder}
        value={roleAliases}
        onChangeText={(value) => {
          markAppSettingsDirty();
          setRoleAliases(value);
        }}
        multiline
        autoCapitalize="none"
      />
      <View style={styles.preferenceRow}>
        <View style={styles.preferenceCopy}>
          <Text style={styles.preferenceTitle}>Application reminders</Text>
          <Text style={styles.muted}>
            Confirm changes you make here and remind you to follow up. External
            employer portals do not update Ntern automatically.
          </Text>
        </View>
        <Switch
          value={applicationReminders}
          onValueChange={(value) => {
            markAppSettingsDirty();
            setApplicationReminders(value);
          }}
          accessibilityLabel="Application reminders"
          trackColor={{ false: colors.border, true: colors.signal }}
          thumbColor={colors.onDark}
        />
      </View>
      {Platform.OS === "web" ? (
        <>
          <Text style={styles.preferenceTitle}>Open application forms</Text>
          <Text style={styles.muted}>Choose how official employer forms open in your browser.</Text>
          <View style={styles.choiceGroup} accessibilityRole="radiogroup">
            <ChoiceOption
              label="Separate window"
              description="Open each form in a full-size browser window."
              selected={applicationHandoff === "window"}
              onPress={() => {
                markAppSettingsDirty();
                setApplicationHandoff("window");
              }}
            />
            <ChoiceOption
              label="New tab"
              description="Keep application forms in your current browser window."
              selected={applicationHandoff === "tab"}
              onPress={() => {
                markAppSettingsDirty();
                setApplicationHandoff("tab");
              }}
            />
          </View>
        </>
      ) : null}
      <Text style={styles.inputLabel}>Follow up after (days)</Text>
      <PlainTextInput
        style={styles.search}
        accessibilityLabel="Follow up after days"
        value={followUpDays}
        onChangeText={(value) => {
          markAppSettingsDirty();
          setFollowUpDays(value);
        }}
        keyboardType="number-pad"
        placeholder="7"
        placeholderTextColor={colors.placeholder}
      />
      <Text style={styles.preferenceTitle}>Live notification preview</Text>
      <View style={styles.notificationPreview}>
        <Text style={styles.notificationPreviewApp}>NTERN</Text>
        <Text style={styles.notificationPreviewTitle}>
          {previewTemplate(titleTemplate, "{shortTitle} — {company}")}
        </Text>
        <Text style={styles.notificationPreviewBody}>
          {previewDescription(
            descriptionTemplate,
            "{location} · {season}{compensationDetail}\n{focus}{postedDetail}\nSource: {source}\n{url}",
          )}
        </Text>
      </View>
      <ActionButton
        label={savingAppSettings ? "Saving…" : "Save app settings"}
        disabled={savingAppSettings}
        onPress={() => void saveAppSettings()}
      />
      <SaveFeedback
        state={appSettingsFeedback}
        onRetry={() => void saveAppSettings()}
      />
      <View style={styles.spacer} />
      <Text style={styles.profileSectionLabel}>Account</Text>
      <Text style={styles.sectionTitle}>Account and support</Text>
      <ActionButton
        label="Privacy policy"
        variant="secondary"
        onPress={() => openLink("Privacy policy", policyUrls.privacy)}
      />
      <View style={styles.buttonGap} />
      <ActionButton
        label="Terms of use"
        variant="secondary"
        onPress={() => openLink("Terms of use", policyUrls.terms)}
      />
      <View style={styles.buttonGap} />
      <ActionButton
        label="Data retention"
        variant="secondary"
        onPress={() => openLink("Data retention", policyUrls.retention)}
      />
      <View style={styles.buttonGap} />
      <ActionButton
        label="Sources and corrections"
        variant="secondary"
        onPress={() => openLink("Sources and corrections", policyUrls.sources)}
      />
      <View style={styles.buttonGap} />
      <ActionButton
        label="Support"
        variant="secondary"
        onPress={() => openLink("Support", policyUrls.support)}
      />
      <View style={styles.spacer} />
      {token ? (
        <>
          <ActionButton
            label={exportingData ? "Generating export…" : "Export my data"}
            variant="secondary"
            disabled={accountActions.exportDisabled}
            onPress={() => void exportMyData()}
          />
          <SaveFeedback state={exportFeedback} onRetry={accountActions.exportRetryEnabled ? () => void exportMyData() : undefined} />
          <View style={styles.spacer} />
          <ActionButton label="Sign out" variant="secondary" disabled={accountActions.signOutDisabled} onPress={() => onSignOut?.()} />
          <View style={styles.spacer} />
          <ActionButton
            label={deletingAccount ? "Deleting account…" : "Delete account"}
            variant="danger"
            disabled={accountActions.deleteDisabled}
            onPress={deleteAccount}
          />
        </>
      ) : (
        <ActionButton label="Sign in or create account" variant="secondary" onPress={onSignIn} />
      )}
        </>
      ) : null}
    </ScrollView>
  );
}

function AuthButton({
  label,
  onPress,
  disabled = false,
  secondary = false,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  secondary?: boolean;
}) {
  return (
    <TouchableOpacity
      accessibilityRole="button"
      aria-disabled={disabled}
      disabled={disabled}
      onPress={onPress}
      style={[
        styles.authButton,
        secondary && styles.authButtonSecondary,
        disabled && styles.authButtonDisabled,
      ]}
    >
      <Text
        style={[
          styles.authButtonText,
          secondary && styles.authButtonTextSecondary,
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

/** Explicitly resets native secure-entry state when iOS recycles text views. */
function PlainTextInput(props: TextInputProps) {
  return <TextInput {...props} secureTextEntry={false} />;
}

function webInputValue(nativeId: string, fallback: string) {
  if (Platform.OS !== "web" || typeof document === "undefined") return fallback;
  const input = document.getElementById(nativeId) as { value?: unknown } | null;
  return typeof input?.value === "string" ? input.value : fallback;
}

function SignIn({
  onSession,
  onBrowse,
}: {
  onSession: (token: string) => void;
  onBrowse?: () => void;
}) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [developmentConfirmationCode, setDevelopmentConfirmationCode] = useState(false);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [createMode, setCreateMode] = useState(false);
  const [ageAttested, setAgeAttested] = useState(false);
  const [policiesAccepted, setPoliciesAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const currentCredentials = () => ({
    email: webInputValue("auth-email", email),
    password: webInputValue("auth-password", password),
  });
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    try {
      await action();
    } catch (error) {
      Alert.alert(
        "Account",
        error instanceof Error ? error.message : "Please try again.",
      );
    } finally {
      setBusy(false);
    }
  };
  const createAccount = async () => {
    const credentials = currentCredentials();
    const result = await signUp(credentials.email, credentials.password, { ageAttested, policiesAccepted });
    if (result.confirmationCode) {
      setCode(result.confirmationCode);
      setDevelopmentConfirmationCode(true);
    } else {
      setDevelopmentConfirmationCode(false);
    }
    setNeedsConfirmation(true);
  };
  const openPolicy = (label: string, url: string | undefined) => {
    if (!url || !/^https:\/\//u.test(url)) {
      Alert.alert(`${label} unavailable`, "This release is missing its required public link.");
      return;
    }
    void Linking.openURL(url).catch(() => Alert.alert(`Could not open ${label.toLowerCase()}`));
  };
  const canCreateAccount = ageAttested && policiesAccepted;
  const title = needsConfirmation
    ? developmentConfirmationCode
      ? "Enter the verification code"
      : "Check your email"
    : createMode
      ? "Create your account"
      : "Sign in";
  const description = needsConfirmation
    ? developmentConfirmationCode
      ? "Email delivery is not configured for this test release, so the development code is filled in below."
      : "Enter the verification code we sent to your email."
    : createMode
      ? "Use an email and password to sync your queue and application details."
      : "Sign in to pick up where you left off.";
  return (
    <SafeAreaView style={styles.authScreen}>
      <KeyboardAvoidingView
        style={styles.authKeyboard}
        behavior={Platform.OS === "ios" ? "padding" : undefined}
      >
        <ScrollView
          contentContainerStyle={styles.authContent}
          keyboardShouldPersistTaps="handled"
        >
          <View style={styles.authBrand}>
            <Text style={styles.eyebrow}>Ntern</Text>
            <Text style={styles.authName}>Save your search.</Text>
            <Text style={styles.authTagline}>
              Track roles and set alerts when you need them.
            </Text>
          </View>
          <View style={styles.authCard}>
            <Text style={styles.authTitle}>{title}</Text>
            <Text style={styles.authDescription}>{description}</Text>
            <Text style={styles.inputLabel}>Email</Text>
            <PlainTextInput
              key="auth-email"
              nativeID="auth-email"
              autoCapitalize="none"
              autoComplete="email"
              accessibilityLabel="Email"
              keyboardType="email-address"
              returnKeyType={needsConfirmation ? "next" : "next"}
              style={styles.authInput}
              placeholder="you@example.com"
              placeholderTextColor={colors.placeholder}
              value={email}
              onChangeText={setEmail}
            />
            {needsConfirmation ? (
              <>
                <Text style={styles.inputLabel}>Verification code</Text>
                <PlainTextInput
                  key="auth-verification-code"
                  autoComplete="one-time-code"
                  accessibilityLabel="Verification code"
                  keyboardType="number-pad"
                  returnKeyType="done"
                  style={styles.authInput}
                  placeholder="6-digit code"
                  placeholderTextColor={colors.placeholder}
                  value={code}
                  onChangeText={setCode}
                />
                <AuthButton
                  label={busy ? "Verifying…" : "Verify email"}
                  disabled={busy}
                  onPress={() =>
                    void run(async () => {
                      await confirmEmail(email, code);
                      setNeedsConfirmation(false);
                      setCreateMode(false);
                      Alert.alert(
                        "Verified",
                        "Your account is ready. Sign in to continue.",
                      );
                    })
                  }
                />
              </>
            ) : (
              <>
                <Text style={styles.inputLabel}>Password</Text>
                <TextInput
                  key="auth-password"
                  nativeID="auth-password"
                  autoComplete={
                    createMode ? "new-password" : "current-password"
                  }
                  accessibilityLabel="Password"
                  secureTextEntry
                  returnKeyType="done"
                  style={styles.authInput}
                  placeholder={
                    createMode ? "At least 12 characters" : "Your password"
                  }
                  placeholderTextColor={colors.placeholder}
                  value={password}
                  onChangeText={setPassword}
                  onSubmitEditing={() => {
                    if (!busy)
                      void run(async () => {
                        if (createMode) {
                          if (canCreateAccount) await createAccount();
                        } else {
                          const credentials = currentCredentials();
                          onSession(await signIn(credentials.email, credentials.password));
                        }
                      });
                  }}
                />
                {createMode ? (
                  <View style={styles.consentGroup}>
                    <TouchableOpacity
                      accessibilityRole="checkbox"
                      aria-checked={ageAttested}
                      onPress={() => setAgeAttested((current) => !current)}
                      style={styles.consentRow}
                    >
                      <View style={[styles.consentBox, ageAttested && styles.consentBoxChecked]}>
                        <Text style={styles.consentMark}>{ageAttested ? "✓" : ""}</Text>
                      </View>
                      <Text style={styles.consentText}>I confirm that I am at least 18 years old.</Text>
                    </TouchableOpacity>
                    <TouchableOpacity
                      accessibilityRole="checkbox"
                      aria-checked={policiesAccepted}
                      onPress={() => setPoliciesAccepted((current) => !current)}
                      style={styles.consentRow}
                    >
                      <View style={[styles.consentBox, policiesAccepted && styles.consentBoxChecked]}>
                        <Text style={styles.consentMark}>{policiesAccepted ? "✓" : ""}</Text>
                      </View>
                      <Text style={styles.consentText}>I agree to the Terms and acknowledge the Privacy Policy.</Text>
                    </TouchableOpacity>
                    <View style={styles.policyLinks}>
                      <Text accessibilityRole="link" onPress={() => openPolicy("Terms", policyUrls.terms)} style={styles.policyLink}>Terms</Text>
                      <Text style={styles.policySeparator}>·</Text>
                      <Text accessibilityRole="link" onPress={() => openPolicy("Privacy Policy", policyUrls.privacy)} style={styles.policyLink}>Privacy Policy</Text>
                    </View>
                  </View>
                ) : null}
                <AuthButton
                  label={
                    busy
                      ? createMode
                        ? "Creating…"
                        : "Signing in…"
                      : createMode
                        ? "Create account"
                        : "Sign in"
                  }
                  disabled={busy || (createMode && !canCreateAccount)}
                  onPress={() =>
                    void run(async () => {
                      if (createMode) {
                        await createAccount();
                      } else {
                        const credentials = currentCredentials();
                        onSession(await signIn(credentials.email, credentials.password));
                      }
                    })
                  }
                />
                <AuthButton
                  secondary
                  label={
                    createMode
                      ? "I already have an account"
                      : "Create an account"
                  }
                  disabled={busy}
                  onPress={() => setCreateMode((current) => !current)}
                />
              </>
            )}
          </View>
          {onBrowse ? (
            <AuthButton
              secondary
              label="Continue browsing"
              onPress={onBrowse}
            />
          ) : null}
          <Text style={styles.authFootnote}>
            Alerts and app settings stay with this device. An account keeps your queue and application details.
          </Text>
        </ScrollView>
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}
const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: colors.canvas },
  guestRoot: { flex: 1 },
  // Keep native list state/layout intact. On web, opacity and pointerEvents
  // alone leave invisible descendants in the keyboard tab order.
  hiddenScreen: Platform.OS === "web"
    ? { display: "none" }
    : { ...StyleSheet.absoluteFillObject, opacity: 0 },
  authOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: colors.canvas },
  appShell: { flex: 1 },
  appShellWide: { flexDirection: "row" },
  appMain: { flex: 1, minWidth: 0 },
  skeleton: { backgroundColor: colors.separator },
  skeletonNav: {
    height: 64,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
    paddingHorizontal: 20,
    borderTopWidth: 1,
    borderTopColor: colors.separator,
  },
  skeletonPage: {
    flex: 1,
    maxWidth: 760,
    paddingTop: 20,
    width: "100%",
  },
  loadingTitleGroup: { marginBottom: 20 },
  skeletonSearch: {
    height: 52,
    backgroundColor: colors.separator,
    borderRadius: 12,
    marginBottom: 24,
  },
  skeletonSection: { marginBottom: 16 },
  skeletonGap8: { height: 8 },
  skeletonGap12: { height: 12 },
  skeletonProfileGap: { height: 24 },
  skeletonField: { marginBottom: 12 },
  skeletonInput: {
    height: 52,
    backgroundColor: colors.separator,
    borderRadius: 12,
  },
  skeletonButton: {
    height: 52,
    backgroundColor: colors.border,
    borderRadius: 12,
    marginTop: 8,
  },
  skeletonNavRail: {
    alignSelf: "stretch",
    borderRightColor: colors.separator,
    borderRightWidth: 1,
    borderTopWidth: 0,
    flexDirection: "column",
    height: undefined,
    justifyContent: "flex-start",
    paddingHorizontal: 24,
    paddingVertical: 28,
    width: 96,
  },
  loadErrorScreen: {
    flex: 1,
    justifyContent: "flex-start",
    paddingHorizontal: 20,
    paddingTop: 32,
  },
  nav: {
    flexDirection: "row",
    height: 64,
    paddingHorizontal: 20,
    alignItems: "center",
    backgroundColor: colors.surface,
    borderTopWidth: 1,
    borderTopColor: colors.separator,
  },
  navItem: { flex: 1, alignItems: "center", justifyContent: "center", minHeight: 52 },
  navRail: {
    alignSelf: "stretch",
    backgroundColor: colors.surface,
    borderRightColor: colors.separator,
    borderRightWidth: 1,
    borderTopWidth: 0,
    flexDirection: "column",
    height: "auto" as unknown as number,
    justifyContent: "flex-start",
    minHeight: "100%" as unknown as number,
    paddingHorizontal: 8,
    paddingVertical: 16,
    width: 96,
  },
  navRailItem: { flex: 0, marginBottom: 8, width: "100%" },
  navLabel: { color: colors.muted, fontSize: 12, fontWeight: "600", marginTop: 3 },
  navLabelActive: { color: colors.ink, fontWeight: "700" },
  navIconWrap: { alignItems: "center", justifyContent: "center" },
  navBadgeText: { color: colors.onDark, fontSize: 11, fontWeight: "700" },
  navBadge: { alignItems: "center", backgroundColor: colors.ink, borderRadius: 9, justifyContent: "center", minWidth: 18, paddingHorizontal: 4, position: "absolute", right: -12, top: -6 },
  inboxHeader: { paddingTop: 28, paddingBottom: 20 },
  inboxCount: {
    color: colors.ink,
    fontSize: 76,
    fontWeight: "800",
    letterSpacing: -3,
    lineHeight: 82,
  },
  inboxTitle: { color: colors.ink, fontSize: 30, fontWeight: "800", letterSpacing: -0.7, lineHeight: 36 },
  inboxDescription: { color: colors.muted, fontSize: 16, lineHeight: 22, marginTop: 6 },
  inboxOverflow: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 6 },
  inboxViewAll: {
    alignItems: "center",
    alignSelf: "flex-start",
    borderColor: colors.signal,
    borderRadius: 10,
    borderWidth: 1,
    justifyContent: "center",
    minHeight: 48,
    paddingHorizontal: 14,
    marginTop: 16,
  },
  inboxViewAllText: { color: colors.signal, fontSize: 15, fontWeight: "700" },
  inboxViewAllFooter: { alignSelf: "center", marginBottom: 12, marginTop: 24 },
  inboxActions: { alignItems: "center", flexDirection: "row", gap: 8, marginTop: 16 },
  inboxViewAllInline: { alignSelf: "auto", marginTop: 0 },
  inboxSectionLabel: { color: colors.signal, fontSize: 12, fontWeight: "700", letterSpacing: 1, marginTop: 28 },
  list: { flex: 1 },
  /** One content column for every tab: same gutter, same left edge, and a height
   * the lists inside can actually scroll in. */
  pageColumn: {
    alignSelf: "center",
    flex: 1,
    maxWidth: 1120,
    paddingHorizontal: 20,
    width: "100%",
  },
  feedListContent: {
    maxWidth: 760,
    paddingBottom: 28,
    width: "100%",
  },
  applicationsListContent: { paddingBottom: 44, paddingTop: 20 },
  catalogSearchBlock: {
    alignSelf: "center",
    maxWidth: 1120,
    paddingBottom: 10,
    paddingHorizontal: 20,
    paddingTop: 12,
    position: "relative",
    width: "100%",
    // The release calendar hangs off this block; keep it above the scrollable grid.
    zIndex: 20,
  },
  catalogSearchBlockWide: { maxWidth: undefined },
  /** Beside the queue sidebar the feed column keeps the shared column's left edge. */
  catalogColumnWide: { flexBasis: "auto", flexGrow: 0, flexShrink: 1, maxWidth: 844, width: "100%" },
  catalogSearchRow: { alignItems: "center", flexDirection: "row", gap: 8 },
  catalogSearchRowStacked: { alignItems: "stretch", flexDirection: "column", gap: 10 },
  catalogSearchControls: { alignItems: "center", flexDirection: "row", gap: 8 },
  catalogSearchControlsStacked: { justifyContent: "space-between" },
  catalogSearchControlTail: { alignItems: "center", flexDirection: "row", gap: 8 },
  calendarAnchor: { position: "relative", zIndex: 20 },
  calendarTrigger: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    minHeight: 48,
    paddingHorizontal: 16,
  },
  calendarTriggerOn: { backgroundColor: colors.signalSoft, borderColor: colors.separator },
  calendarTriggerText: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  calendarTriggerTextOn: { color: colors.signal },
  calendarScrim: { backgroundColor: "transparent", bottom: -400, left: -400, position: "absolute", right: -400, top: -400 },
  calendarInlinePanel: {
    alignSelf: "flex-start",
    backgroundColor: colors.surface,
    borderColor: colors.separator,
    borderRadius: 16,
    borderWidth: 1,
    marginTop: 10,
    padding: 12,
  },
  calendarPopover: {
    backgroundColor: colors.surface,
    borderColor: colors.separator,
    borderRadius: 16,
    borderWidth: 1,
    padding: 12,
    position: "absolute",
    right: 0,
    top: 52,
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 8 },
    shadowOpacity: 0.12,
    shadowRadius: 24,
    zIndex: 30,
  },
  calendarHeader: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  calendarMonthButton: { alignItems: "center", height: 40, justifyContent: "center", width: 40 },
  calendarMonth: { color: colors.ink, fontSize: 15, fontWeight: "800" },
  calendarWeekdays: { flexDirection: "row", marginTop: 4 },
  calendarWeekday: { color: colors.muted, fontSize: 11, fontWeight: "700", textAlign: "center", width: `${100 / 7}%` },
  calendarGrid: { flexDirection: "row", flexWrap: "wrap", marginTop: 2 },
  calendarCell: { alignItems: "center", justifyContent: "center", paddingVertical: 2, width: `${100 / 7}%` },
  calendarDay: {
    alignItems: "center",
    borderColor: "transparent",
    borderRadius: 10,
    borderWidth: 1,
    height: 38,
    justifyContent: "center",
    width: 38,
  },
  calendarDayEmpty: { opacity: 0.45 },
  calendarDayToday: { borderColor: colors.signal },
  calendarDaySelected: { backgroundColor: colors.ink, borderColor: colors.ink },
  calendarDayText: { color: colors.ink, fontSize: 13, fontWeight: "700", lineHeight: 15 },
  calendarDayMutedText: { color: colors.muted, fontSize: 13, fontWeight: "600", lineHeight: 15 },
  calendarDayCount: { color: colors.signal, fontSize: 10, fontWeight: "800", lineHeight: 12 },
  calendarDayTextSelected: { color: colors.onDark },
  calendarFooter: { alignItems: "center", borderTopColor: colors.separator, borderTopWidth: 1, flexDirection: "row", justifyContent: "space-between", marginTop: 8, paddingTop: 8 },
  calendarZone: { color: colors.body, fontSize: 12, fontWeight: "700" },
  calendarFooterNote: { color: colors.muted, fontSize: 11, fontWeight: "600" },
  calendarClear: { alignItems: "center", justifyContent: "center", minHeight: 40, paddingTop: 6 },
  calendarClearText: { color: colors.signal, fontSize: 13, fontWeight: "700" },
  catalogSearchField: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 12,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row",
    gap: 8,
    minHeight: 52,
    paddingHorizontal: 14,
  },
  catalogSearchFieldFocused: { borderColor: colors.signal, borderWidth: 2, paddingHorizontal: 13 },
  catalogSearchInput: { color: colors.ink, flex: 1, fontSize: 16, minHeight: 48, paddingVertical: 0 },
  catalogSearchClear: { alignItems: "center", height: 44, justifyContent: "center", width: 30 },
  catalogTokenRow: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 10 },
  catalogToken: {
    alignItems: "center",
    backgroundColor: colors.signalSoft,
    borderColor: colors.separator,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    minHeight: 34,
    paddingHorizontal: 12,
  },
  catalogTokenText: { color: colors.signal, fontSize: 13, fontWeight: "700" },
  catalogTokenClear: { alignItems: "center", justifyContent: "center", minHeight: 34, paddingHorizontal: 8 },
  catalogTokenClearText: { color: colors.muted, fontSize: 13, fontWeight: "700", textDecorationLine: "underline" },
  catalogSummary: { color: colors.muted, fontSize: 13, fontWeight: "600", marginTop: 10 },
  catalogGrid: {
    alignSelf: "center",
    maxWidth: 1120,
    paddingBottom: 28,
    paddingHorizontal: 20,
    width: "100%",
  },
  catalogGridRow: { alignItems: "stretch", flexDirection: "row", gap: 12, marginBottom: 12 },
  catalogCell: { flex: 1, minWidth: 0 },
  catalogCellStack: { flexGrow: 1 },
  catalogTile: {
    backgroundColor: colors.surface,
    borderColor: colors.separator,
    borderRadius: 14,
    borderWidth: 1,
    flexGrow: 1,
    padding: 13,
  },
  catalogTileLane: { padding: 16 },
  catalogTileTop: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", minHeight: 22 },
  catalogTileTags: { alignItems: "center", flexDirection: "row", flexShrink: 1, gap: 6, minWidth: 0 },
  catalogTileNew: { alignItems: "center", flexDirection: "row", flexShrink: 0, gap: 3 },
  catalogTileNewText: { color: colors.signal, fontSize: 11, fontWeight: "800" },
  catalogTileCompany: { color: colors.signal, fontSize: 13, fontWeight: "700", lineHeight: 18, marginTop: 8 },
  catalogTileTitle: { color: colors.ink, fontSize: 15, fontWeight: "700", lineHeight: 20, marginTop: 2 },
  catalogTileTitleLane: { fontSize: 17, lineHeight: 22 },
  catalogTileMeta: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 4 },
  catalogTileComp: { color: colors.ink, fontSize: 12, fontWeight: "700", lineHeight: 17, marginTop: 3 },
  catalogTileTiming: { color: colors.muted, fontSize: 12, lineHeight: 16, marginTop: 3 },
  catalogTileNotice: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 3 },
  catalogTileFooter: {
    alignItems: "center",
    borderTopColor: colors.separator,
    borderTopWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 10,
    paddingTop: 8,
  },
  catalogTileState: { alignItems: "center", flexDirection: "row", flexShrink: 1, gap: 6, minWidth: 0 },
  catalogTileStateText: { color: colors.signal, fontSize: 11, fontWeight: "800", letterSpacing: 0.4 },
  catalogTileActions: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 4, justifyContent: "flex-end" },
  catalogTileAction: {
    alignItems: "center",
    borderRadius: 10,
    flexDirection: "row",
    gap: 5,
    justifyContent: "center",
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 6,
  },
  catalogTileActionActive: { backgroundColor: colors.signalSoft },
  catalogTileActionText: { color: colors.ink, fontSize: 12, fontWeight: "700" },
  catalogTileActionActiveText: { color: colors.signal, fontSize: 12, fontWeight: "700" },
  catalogTileActionStrong: { fontWeight: "800" },
  catalogGroupCountPill: { backgroundColor: colors.ink, borderRadius: 999, paddingHorizontal: 8, paddingVertical: 3 },
  catalogGroupCountText: { color: colors.onDark, fontSize: 11, fontWeight: "800" },
  catalogLane: { marginBottom: 8, marginTop: 6 },
  catalogLaneHeader: { alignItems: "flex-start", flexDirection: "row", gap: 12, justifyContent: "space-between", marginBottom: 14, paddingTop: 2 },
  catalogLaneHeading: { flexShrink: 1, gap: 2 },
  catalogLaneControl: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: 999,
    borderWidth: 1,
    flexDirection: "row",
    gap: 6,
    minHeight: 48,
    paddingHorizontal: 14,
  },
  catalogLaneControlText: { color: colors.body, fontSize: 13, fontWeight: "700" },
  /** Deliberate section separation: a hairline of ink, not the near-invisible
   * separator colour, so the band below reads as a different list. */
  catalogLaneRule: {
    backgroundColor: colors.ink,
    height: 1,
    marginBottom: 22,
    marginTop: 24,
    opacity: 0.2,
  },
  catalogLaneTitle: { color: colors.ink, fontSize: 17, fontWeight: "800", lineHeight: 22 },
  catalogLaneCaption: { color: colors.muted, fontSize: 13, fontWeight: "600" },
  catalogLaneList: { gap: 12, paddingBottom: 4 },
  catalogTileSkeleton: {
    backgroundColor: colors.surface,
    borderColor: colors.separator,
    borderRadius: 14,
    borderWidth: 1,
    flex: 1,
    gap: 8,
    minWidth: 0,
    padding: 13,
  },
  catalogEmptyTitle: { color: colors.ink, fontSize: 17, fontWeight: "800", lineHeight: 22 },
  catalogEmptyCopy: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 6 },
  catalogEmptyAction: { marginTop: 4, maxWidth: 280 },
  catalogPagination: { alignItems: "center", minHeight: 52, justifyContent: "center", paddingVertical: 12 },
  catalogPaginationText: { color: colors.muted, fontSize: 14, lineHeight: 20, textAlign: "center" },
  catalogPaginationRetry: { alignItems: "center", justifyContent: "center", minHeight: 44, paddingHorizontal: 12 },
  catalogPaginationRetryText: { color: colors.signal, fontSize: 14, fontWeight: "700" },
  profileContent: {
    maxWidth: 760,
    paddingBottom: 44,
    paddingTop: 24,
    width: "100%",
  },
  settingsList: { borderTopColor: colors.separator, borderTopWidth: 1 },
  settingsRow: {
    alignItems: "center",
    borderBottomColor: colors.separator,
    borderBottomWidth: 1,
    flexDirection: "row",
    minHeight: 88,
    paddingVertical: 14,
  },
  settingsRowIcon: {
    alignItems: "center",
    backgroundColor: colors.signalSoft,
    borderRadius: 10,
    height: 40,
    justifyContent: "center",
    width: 40,
  },
  settingsRowCopy: { flex: 1, paddingHorizontal: 14 },
  settingsRowTitle: { color: colors.ink, fontSize: 17, fontWeight: "700", lineHeight: 22 },
  settingsRowDescription: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 2 },
  settingsBack: {
    alignItems: "center",
    alignSelf: "flex-start",
    flexDirection: "row",
    marginBottom: 16,
    marginLeft: -6,
    minHeight: 44,
    paddingRight: 10,
  },
  settingsBackText: { color: colors.signal, fontSize: 16, fontWeight: "700" },
  pageHeading: { marginBottom: 0 },
  card: {
    backgroundColor: colors.surface,
    padding: 16,
    marginBottom: 12,
    borderRadius: 14,
    borderWidth: 1,
    borderColor: colors.separator,
  },
  mobileRoleCard: { marginBottom: 10, padding: 13 },
  mobileRoleTitle: { fontSize: 16, lineHeight: 22, marginTop: 3 },
  mobileRoleMeta: { fontSize: 13, lineHeight: 19, marginTop: 3 },
  mobileRoleSource: { marginTop: -2 },
  mobileRoleTiming: { fontSize: 12, lineHeight: 17 },
  mobileRoleFooter: { marginTop: 9 },
  catalogGroupCard: {
    backgroundColor: colors.surface,
    borderColor: colors.separator,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 12,
    padding: 16,
  },
  catalogGroupTopline: { alignItems: "center", flexDirection: "row", justifyContent: "space-between", gap: 12 },
  catalogGroupCount: {
    backgroundColor: colors.signalSoft,
    borderRadius: 999,
    color: colors.signal,
    flexShrink: 0,
    fontSize: 12,
    fontWeight: "800",
    paddingHorizontal: 9,
    paddingVertical: 5,
  },
  catalogGroupTitle: { color: colors.ink, fontSize: 18, fontWeight: "700", lineHeight: 25, marginTop: 7 },
  catalogGroupMeta: { color: colors.muted, fontSize: 14, lineHeight: 20, marginTop: 7 },
  catalogGroupEducation: { color: colors.body, fontSize: 13, lineHeight: 19, marginTop: 5 },
  catalogGroupIdentity: { color: colors.muted, fontSize: 13, fontWeight: "600", lineHeight: 19, marginTop: 6 },
  catalogGroupSheet: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    maxHeight: "88%",
    minHeight: 280,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 28,
  },
  catalogGroupSheetHeader: { paddingBottom: 18 },
  catalogGroupLoading: { minHeight: 220 },
  catalogGroupSkeletonHeader: { paddingBottom: 18 },
  catalogGroupErrorState: { gap: 16, justifyContent: "center", minHeight: 220 },
  catalogGroupError: { color: colors.danger, fontSize: 15, lineHeight: 21, textAlign: "center" },
  catalogGroupRoles: { borderTopColor: colors.separator, borderTopWidth: 1, paddingBottom: 8 },
  catalogGroupRole: {
    alignItems: "center",
    borderBottomColor: colors.separator,
    borderBottomWidth: 1,
    flexDirection: "row",
    minHeight: 76,
    paddingVertical: 13,
  },
  catalogGroupRoleCopy: { flex: 1, paddingRight: 12 },
  catalogGroupRoleTitle: { color: colors.ink, fontSize: 16, fontWeight: "700", lineHeight: 22 },
  catalogGroupRoleMeta: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 3 },
  catalogGroupRolePay: { color: colors.success, fontSize: 13, fontWeight: "700", marginTop: 6 },
  swipeCard: { marginBottom: 12, position: "relative" },
  swipeCardSurface: { marginBottom: 0 },
  swipeSaveAction: {
    alignItems: "center",
    backgroundColor: colors.ink,
    borderRadius: 14,
    bottom: 0,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    paddingLeft: 16,
    position: "absolute",
    right: 0,
    top: 0,
    width: 112,
  },
  swipeSaveActionText: { color: "#FFFFFF", fontSize: 14, fontWeight: "800" },
  swipeHideAction: {
    alignItems: "center",
    backgroundColor: colors.body,
    borderRadius: 14,
    bottom: 0,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    paddingRight: 16,
    position: "absolute",
    left: 0,
    top: 0,
    width: 112,
  },
  swipeHideActionText: { color: colors.onDark, fontSize: 14, fontWeight: "800" },
  disciplinePill: { borderRadius: 999, borderWidth: 1, paddingHorizontal: 8, paddingVertical: 4 },
  disciplinePillText: { fontSize: 11, fontWeight: "800", letterSpacing: 0.2 },
  jobCardTopTags: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginLeft: 8, flexShrink: 1, justifyContent: "flex-end" },
  jobCardMidPills: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginTop: 8 },
  jobCardFooterLeft: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12, gap: 12 },
  jobCardBottomActions: { flexDirection: "row", alignItems: "center", gap: 8, flexShrink: 0 },
  catalogGroupTopTags: { flexDirection: "row", flexWrap: "wrap", gap: 6, marginLeft: 8, flexShrink: 1, justifyContent: "flex-end" },
  catalogGroupFooterLeft: { flexDirection: "row", alignItems: "center", justifyContent: "space-between", marginTop: 12, gap: 12 },
  jobCardActionCompact: { alignItems: "center", flexDirection: "row", gap: 4 },
  jobCompanyLeft: { flexDirection: "row", alignItems: "center", flex: 1, minWidth: 0 },
  sheetSaveBar: { alignItems: "center", backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, flexDirection: "row", gap: 8, justifyContent: "center", minHeight: 52, paddingHorizontal: 16 },
  sheetSaveBarText: { color: colors.ink, fontSize: 16, fontWeight: "800" },
  sheetInQueueBar: { alignItems: "center", backgroundColor: colors.signalSoft, borderColor: colors.separator, borderRadius: 12, borderWidth: 1, flexDirection: "row", gap: 8, justifyContent: "center", minHeight: 52, paddingHorizontal: 16 },
  sheetInQueueBarText: { color: colors.signal, fontSize: 16, fontWeight: "800" },
  sheetHideBar: { alignItems: "center", backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 12, borderWidth: 1, flexDirection: "row", gap: 8, justifyContent: "center", minHeight: 52, paddingHorizontal: 16 },
  sheetHideBarText: { color: colors.body, fontSize: 16, fontWeight: "700" },
  webQueueButtonCompact: { alignItems: "center", backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 999, borderWidth: 1, flexDirection: "row", gap: 6, justifyContent: "center", minHeight: 32, paddingHorizontal: 10 },
  webQueueButtonText: { color: colors.ink, fontSize: 13, fontWeight: "800" },
  webInQueueButtonCompact: { alignItems: "center", backgroundColor: colors.signalSoft, borderColor: colors.separator, borderRadius: 999, borderWidth: 1, flexDirection: "row", gap: 6, justifyContent: "center", minHeight: 32, paddingHorizontal: 10 },
  webInQueueButtonText: { color: colors.signal, fontSize: 13, fontWeight: "800" },
  webHideButton: { alignItems: "center", backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 999, borderWidth: 1, flexDirection: "row", gap: 6, justifyContent: "center", minHeight: 36, paddingHorizontal: 12 },
  webHideButtonCompact: { alignItems: "center", backgroundColor: colors.surface, borderColor: colors.border, borderRadius: 999, borderWidth: 1, flexDirection: "row", gap: 6, justifyContent: "center", minHeight: 32, paddingHorizontal: 10 },
  webHideButtonText: { color: colors.muted, fontSize: 13, fontWeight: "700" },
  newRoleGlow: {
    backgroundColor: colors.signalGlow,
    borderRadius: 14,
    bottom: 0,
    left: 0,
    position: "absolute",
    right: 0,
    top: 0,
  },
  sheetOverlay: {
    flex: 1,
    backgroundColor: colors.overlay,
    justifyContent: "flex-end",
  },
  sheetDismissArea: { flex: 1 },
  jobSheet: {
    backgroundColor: colors.canvas,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 32,
    maxHeight: "92%",
  },
  sheetContent: { paddingBottom: 4 },
  sheetHandle: {
    alignSelf: "center",
    backgroundColor: colors.border,
    borderRadius: 2,
    height: 4,
    marginBottom: 24,
    width: 40,
  },
  sheetEyebrow: {
    color: colors.signal,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  sheetTitle: {
    color: colors.ink,
    fontSize: 26,
    fontWeight: "800",
    letterSpacing: -0.5,
    lineHeight: 32,
  },
  sheetCompany: {
    color: colors.body,
    fontSize: 17,
    fontWeight: "600",
    lineHeight: 24,
    marginTop: 8,
  },
  sheetDetail: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 22,
    marginTop: 4,
  },
  sheetTrustBlock: { gap: 3, marginTop: 16 },
  sheetTrustPrimary: { color: colors.body, fontSize: 14, fontWeight: "700", lineHeight: 20 },
  sheetTrustSecondary: { color: colors.muted, fontSize: 13, lineHeight: 19 },
  sheetIdentityNotice: {
    alignItems: "flex-start",
    backgroundColor: colors.signalSoft,
    borderRadius: 12,
    flexDirection: "row",
    gap: 9,
    marginTop: 18,
    padding: 14,
  },
  sheetIdentityNoticeText: { color: colors.body, flex: 1, fontSize: 14, lineHeight: 20 },
  sheetMatchBlock: {
    backgroundColor: colors.signalSoft,
    borderRadius: 12,
    marginTop: 18,
    padding: 14,
  },
  sheetMatchTitle: { color: colors.ink, fontSize: 14, fontWeight: "700", lineHeight: 20 },
  sheetMatchText: { color: colors.body, fontSize: 14, lineHeight: 20, marginTop: 3 },
  sheetMatchHelper: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 3 },
  sheetClosedNotice: {
    backgroundColor: colors.dangerSoft,
    borderColor: colors.dangerBorder,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 20,
    padding: 12,
  },
  sheetClosedText: { color: colors.danger, fontSize: 14, fontWeight: "600", lineHeight: 20 },
  sheetActions: { gap: 12, marginTop: 28 },
  applyNowButton: {
    alignItems: "center",
    backgroundColor: colors.ink,
    borderRadius: 12,
    flexDirection: "row",
    gap: 12,
    justifyContent: "center",
    minHeight: 52,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  applyNowTitle: { color: colors.onDark, flex: 1, minWidth: 0, fontSize: 17, fontWeight: "700", lineHeight: 22, textAlign: "center" },
  applyNowArrow: { flexShrink: 0 },
  sheetHelper: {
    color: colors.muted,
    fontSize: 13,
    lineHeight: 19,
    marginTop: 14,
    textAlign: "center",
  },
  catalogUnavailable: { gap: 16 },
  company: {
    color: colors.signal,
    flexShrink: 1,
    fontSize: 13,
    fontWeight: "700",
  },
  jobCompanyRow: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  newSpark: {
    alignItems: "center",
    backgroundColor: colors.signalSoft,
    borderRadius: 999,
    flexDirection: "row",
    gap: 4,
    marginLeft: 8,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  newSparkText: { color: colors.signal, fontSize: 11, fontWeight: "800", letterSpacing: 0.2 },
  title: {
    color: colors.ink,
    fontSize: 17,
    fontWeight: "700",
    lineHeight: 24,
    marginTop: 4,
  },
  sectionTitle: {
    fontSize: 22,
    fontWeight: "700",
    color: colors.ink,
    letterSpacing: -0.3,
  },
  muted: { color: colors.muted, marginTop: 4, lineHeight: 21 },
  postingTiming: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 2 },
  jobSourceRow: { alignItems: "center", flexDirection: "row", flexWrap: "wrap", gap: 5, marginTop: 7 },
  jobSourceText: { color: colors.muted, flexShrink: 1, fontSize: 13, fontWeight: "600", lineHeight: 18 },
  jobSourceCorroboration: { color: colors.signal, fontSize: 12, fontWeight: "700", lineHeight: 18 },
  pay: { color: colors.success, fontSize: 13, fontWeight: "700", marginTop: 6 },
  payInline: { color: colors.success, fontSize: 13, fontWeight: "700" },
  closedStatus: { marginTop: 8, color: colors.danger, fontWeight: "700" },
  jobCardAction: { alignItems: "center", flexDirection: "row", marginTop: 14 },
  jobCardActionText: { color: colors.signal, fontSize: 15, fontWeight: "700" },
  jobCardActionArrow: { color: colors.signal, fontSize: 22, lineHeight: 20, marginLeft: 5 },
  identityTrustRow: { alignItems: "center", flexDirection: "row", gap: 5, marginTop: 6 },
  identityTrustText: { color: colors.muted, fontSize: 13, fontWeight: "600", lineHeight: 18 },
  search: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    color: colors.ink,
    fontSize: 16,
    minHeight: 52,
    paddingHorizontal: 14,
    marginBottom: 12,
  },
  roleWorkspace: { flex: 1, minHeight: 0, width: "100%" },
  roleWorkspaceWide: {
    alignSelf: "center",
    flexDirection: "row",
    gap: 24,
    justifyContent: "center",
    maxWidth: 1440,
  },
  roleFeedColumn: { flex: 1, minHeight: 0, minWidth: 0 },
  roleFeedList: { flex: 1, zIndex: 0 },
  feedListContentWide: { maxWidth: undefined },
  queueSidebar: { flexGrow: 0, flexShrink: 0, paddingTop: 12, width: 252 },
  catalogSourceFilters: { flexDirection: "row", flexWrap: "wrap", gap: 8, marginBottom: 12, marginTop: 12 },
  filterRegion: { marginTop: 12, marginBottom: 12 },
  filterBar: { flexDirection: "row", alignItems: "center", minHeight: 48 },
  filterToggle: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 48,
    paddingHorizontal: 16,
  },
  filterToggleText: { color: colors.signal, fontSize: 15, fontWeight: "700" },
  filterToggleGlyph: { color: colors.signal, fontSize: 20, fontWeight: "400", marginLeft: 8 },
  filterSheetOverlay: { flex: 1, justifyContent: "flex-end", backgroundColor: "rgba(0,0,0,0.4)" },
  filterSheet: {
    backgroundColor: colors.surface,
    borderTopLeftRadius: 24,
    borderTopRightRadius: 24,
    borderTopWidth: 1,
    borderTopColor: colors.separator,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 12,
    shadowOffset: { width: 0, height: -2 },
    elevation: 8,
    maxHeight: "88%",
    minHeight: 280,
    paddingHorizontal: 20,
    paddingTop: 12,
    paddingBottom: 34,
  },
  filterSheetApply: { alignSelf: "stretch" },
  filterSheetClear: { alignSelf: "center", minHeight: 48, justifyContent: "center", paddingHorizontal: 16 },
  filterSheetScroll: { marginTop: 8 },
  filterSheetContent: { paddingBottom: 16 },
  filterSheetActions: { alignItems: "stretch", flexDirection: "column", gap: 4, marginTop: 12, borderTopWidth: 1, borderTopColor: colors.separator, paddingTop: 12 },
  clearFiltersText: { color: colors.muted, fontSize: 15, fontWeight: "600" },
  coverageRegion: {
    borderTopColor: colors.separator,
    borderTopWidth: 1,
    marginTop: 4,
  },
  coverageToggle: {
    alignItems: "center",
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 58,
    paddingVertical: 8,
    gap: 12,
  },
  coverageToggleCopy: { flex: 1, minWidth: 0 },
  coverageToggleTitle: { color: colors.ink, fontSize: 15, fontWeight: "700" },
  coverageToggleSummary: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: 2 },
  coveragePanel: { paddingBottom: 12 },
  coverageStats: {
    flexDirection: "row",
    gap: 28,
    marginBottom: 12,
    marginTop: 4,
  },
  coverageStatValue: { color: colors.ink, fontSize: 21, fontWeight: "800" },
  coverageStatLabel: { color: colors.muted, fontSize: 12, marginTop: 2 },
  coverageExplanation: { color: colors.muted, fontSize: 14, lineHeight: 20, marginBottom: 12 },
  coverageSearch: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 15,
    minHeight: 46,
    paddingHorizontal: 12,
  },
  coverageResults: { marginTop: 8 },
  coverageRow: {
    alignItems: "center",
    borderBottomColor: colors.separator,
    borderBottomWidth: 1,
    flexDirection: "row",
    justifyContent: "space-between",
    minHeight: 56,
    paddingVertical: 8,
  },
  coverageCompanyCopy: { flex: 1, paddingRight: 16 },
  coverageCompany: { color: colors.ink, fontSize: 15, fontWeight: "700" },
  coverageCompanyState: { color: colors.muted, fontSize: 12, marginTop: 3, textTransform: "capitalize" },
  coverageRoleCount: { color: colors.body, fontSize: 13, fontWeight: "600" },
  coverageAsOf: { color: colors.muted, fontSize: 12, marginTop: 12 },
  filterLabel: { color: colors.body, fontSize: 13, fontWeight: "700", marginBottom: 8 },
  companyFilter: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
    marginBottom: 16,
  },
  formInput: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    borderRadius: 10,
    color: colors.ink,
    fontSize: 16,
    minHeight: 52,
    paddingHorizontal: 14,
    marginBottom: 20,
  },
  multiline: { minHeight: 96, textAlignVertical: "top" },
  emptyState: {
    alignItems: "flex-start",
    paddingTop: 32,
    paddingBottom: 24,
  },
  emptyTitle: {
    color: colors.ink,
    fontSize: 21,
    fontWeight: "700",
    letterSpacing: -0.25,
  },
  emptyCopy: { color: colors.muted, fontSize: 15, lineHeight: 22, marginTop: 6 },
  onboardingScreen: { flex: 1, backgroundColor: colors.canvas },
  onboardingContent: {
    flexGrow: 1,
    paddingHorizontal: 20,
    paddingTop: 42,
    paddingBottom: 36,
  },
  eyebrow: {
    color: colors.signal,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  pageTitle: {
    color: colors.ink,
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.6,
    lineHeight: 34,
  },
  hero: { fontSize: 30, fontWeight: "800", color: colors.ink, letterSpacing: -0.6, lineHeight: 36 },
  profileHero: { marginBottom: 0 },
  pageDescription: { color: colors.muted, fontSize: 16, lineHeight: 22, marginTop: 6, marginBottom: 16 },
  intro: { color: colors.muted, fontSize: 16, lineHeight: 23, marginTop: 10, marginBottom: 28 },
  chips: { flexDirection: "row", flexWrap: "wrap", marginTop: 8, marginBottom: 24, gap: 8 },
  chip: {
    borderWidth: 1,
    borderColor: colors.border,
    minHeight: 48,
    paddingHorizontal: 14,
    justifyContent: "center",
    borderRadius: 999,
    backgroundColor: colors.surface,
  },
  chipOn: { backgroundColor: colors.signalSoft, borderColor: colors.signal },
  chipExclude: { backgroundColor: colors.dangerSoft, borderColor: colors.danger },
  chipLabel: { color: colors.body, fontSize: 14, fontWeight: "700" },
  chipLabelOn: { color: colors.signal },
  chipLabelExclude: { color: colors.danger },
  optionalLabel: { color: colors.muted, fontWeight: "400" },
  helperText: { color: colors.muted, fontSize: 13, lineHeight: 19, textAlign: "center", marginTop: 14 },
  preferenceRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    borderTopWidth: 1,
    borderTopColor: colors.separator,
    marginTop: 12,
    paddingVertical: 16,
  },
  preferenceCopy: { flex: 1, paddingRight: 16 },
  onboardingAlertRow: {
    flexDirection: "row",
    alignItems: "center",
    borderTopWidth: 1,
    borderTopColor: colors.separator,
    paddingTop: 16,
    marginBottom: 20,
  },
  preferenceTitle: {
    color: colors.ink,
    fontSize: 16,
    fontWeight: "700",
    marginTop: 12,
  },
  choiceGroup: { marginTop: 12, marginBottom: 16, gap: 8 },
  choiceOption: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.separator,
    borderRadius: 10,
    borderWidth: 1,
    flexDirection: "row",
    minHeight: 64,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  choiceOptionSelected: { backgroundColor: colors.signalSoft, borderColor: colors.signal },
  choiceCopy: { flex: 1, paddingRight: 12 },
  choiceLabel: { color: colors.ink, fontSize: 15, fontWeight: "700" },
  choiceLabelSelected: { color: colors.signal },
  choiceDescription: { color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 3 },
  choiceMark: {
    alignItems: "center",
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    height: 20,
    justifyContent: "center",
    width: 20,
  },
  choiceMarkSelected: { borderColor: colors.signal },
  choiceMarkDot: { backgroundColor: colors.signal, borderRadius: 5, height: 10, width: 10 },
  timeRow: { flexDirection: "row", gap: 12 },
  timeField: { flex: 1 },
  notificationPreview: {
    backgroundColor: colors.ink,
    borderRadius: 14,
    marginTop: 10,
    marginBottom: 16,
    padding: 16,
  },
  notificationPreviewApp: {
    color: "#A5F3FC",
    fontSize: 11,
    fontWeight: "800",
    letterSpacing: 1,
  },
  notificationPreviewTitle: { color: colors.onDark, fontSize: 16, fontWeight: "700", marginTop: 6 },
  notificationPreviewBody: { color: "#D1D1D6", fontSize: 14, lineHeight: 20, marginTop: 4 },
  saveFeedback: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    marginTop: 12,
    padding: 12,
  },
  saveFeedbackSuccess: { backgroundColor: colors.successSoft, borderColor: colors.successBorder },
  saveFeedbackError: { backgroundColor: colors.dangerSoft, borderColor: colors.dangerBorder },
  saveFeedbackText: { color: colors.body, fontSize: 14, lineHeight: 20 },
  saveFeedbackRetry: { color: colors.signal, fontSize: 14, fontWeight: "700", marginTop: 8 },
  hiddenRolePlaceholder: {
    alignItems: "center",
    borderColor: colors.separator,
    borderRadius: 14,
    borderWidth: 1,
    flexDirection: "row",
    gap: 14,
    justifyContent: "center",
    minHeight: 88,
    paddingHorizontal: 16,
    paddingVertical: 16,
  },
  hiddenRolePlaceholderText: { color: colors.body, fontSize: 14, fontWeight: "600" },
  hiddenRolePlaceholderUndo: { color: colors.signal, fontSize: 14, fontWeight: "800" },
  profileSectionLabel: {
    color: colors.signal,
    fontSize: 12,
    fontWeight: "700",
    letterSpacing: 0.4,
    marginBottom: 8,
  },
  statusPill: {
    alignSelf: "flex-start",
    borderRadius: 999,
    marginTop: 14,
    paddingHorizontal: 10,
    paddingVertical: 5,
  },
  statusPillText: {
    color: colors.signal,
    fontSize: 12,
    fontWeight: "800",
    letterSpacing: 0.5,
  },
  hiddenRolesList: { marginTop: 12, gap: 8 },
  hiddenRoleRow: {
    alignItems: "center",
    borderTopColor: colors.separator,
    borderTopWidth: 1,
    flexDirection: "row",
    gap: 12,
    paddingTop: 12,
  },
  hiddenRoleCopy: { flex: 1 },
  hiddenRoleTitle: { color: colors.ink, fontSize: 15, fontWeight: "700", lineHeight: 20, marginTop: 2 },
  applicationActionGap: { marginTop: 14 },
  applicationActionRow: { flexDirection: "row", gap: 12 },
  applicationDataList: { marginTop: 12, gap: 8 },
  applicationDataRow: { borderTopColor: colors.separator, borderTopWidth: 1, paddingTop: 12, gap: 2 },
  applicationDataTitle: { color: colors.ink, fontSize: 15, fontWeight: "700", lineHeight: 20 },
  applicationDataMeta: { color: colors.muted, fontSize: 13, lineHeight: 18 },
  queueCompactCard: {
    backgroundColor: colors.surface,
    borderColor: colors.separator,
    borderRadius: 14,
    borderWidth: 1,
    marginTop: 10,
    padding: 14,
  },
  queueCompactTop: { alignItems: "center", flexDirection: "row" },
  queueCompactCopy: { flex: 1, minWidth: 0, paddingHorizontal: 10 },
  queueCompactCompany: { color: colors.signal, fontSize: 12, fontWeight: "700", lineHeight: 17 },
  queueCompactTitle: { color: colors.ink, fontSize: 15, fontWeight: "700", lineHeight: 20, marginTop: 1 },
  queueCompactRemove: { alignItems: "center", justifyContent: "center", minHeight: 44, minWidth: 44 },
  queuePendingText: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  queueCompactUnavailable: { color: colors.muted, fontSize: 12, lineHeight: 18, marginLeft: 38, marginTop: 6 },
  queueCompactActions: { flexDirection: "row", gap: 8, marginTop: 10 },
  queueCompactOpen: {
    alignItems: "center",
    backgroundColor: colors.ink,
    borderRadius: 10,
    flex: 1,
    flexDirection: "row",
    gap: 7,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 10,
  },
  queueCompactOpenText: { color: colors.onDark, fontSize: 14, fontWeight: "700" },
  queueCompactProgress: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    flex: 1,
    flexDirection: "row",
    gap: 6,
    justifyContent: "center",
    minHeight: 44,
    paddingHorizontal: 10,
  },
  queueCompactProgressText: { color: colors.signal, fontSize: 14, fontWeight: "700" },
  queueCompactActionDisabled: { opacity: 0.5 },
  queueScreen: { flex: 1 },
  queueActionBar: { alignItems: "center", backgroundColor: colors.surface, borderTopColor: colors.separator, borderTopWidth: 1, flexDirection: "row", gap: 8, paddingHorizontal: 16, paddingVertical: 12 },
  queueActionPrimary: { flex: 1, minWidth: 0 },
  queueActionSecondary: { flexShrink: 0, width: 56 },
  queueCount: { color: colors.ink, fontSize: 17, fontWeight: "700", marginBottom: 12 },
  queuePill: {
    alignItems: "center",
    backgroundColor: colors.signalSoft,
    borderColor: colors.signal,
    borderRadius: 12,
    borderWidth: 1,
    flexDirection: "row",
    gap: 7,
    minHeight: 44,
    paddingHorizontal: 12,
  },
  queuePillText: { color: colors.signal, fontSize: 14, fontWeight: "700" },
  queuePillCount: {
    backgroundColor: colors.signal,
    borderRadius: 10,
    color: colors.onDark,
    fontSize: 12,
    fontWeight: "800",
    minWidth: 20,
    overflow: "hidden",
    paddingHorizontal: 5,
    paddingVertical: 2,
    textAlign: "center",
  },
  queueSheet: { backgroundColor: colors.surface, borderTopLeftRadius: 16, borderTopRightRadius: 16, maxHeight: 560, padding: 20 },
  queueSheetList: { marginVertical: 12, maxHeight: 320 },
  queueSheetRow: { alignItems: "center", borderTopColor: colors.separator, borderTopWidth: 1, flexDirection: "row", justifyContent: "space-between", minHeight: 64, paddingVertical: 10 },
  queueSheetCopy: { alignItems: "center", flex: 1, flexDirection: "row", gap: 10, marginRight: 12 },
  queueSheetPositionBadge: { alignItems: "center", backgroundColor: colors.canvas, borderRadius: 14, height: 28, justifyContent: "center", width: 28 },
  queueSheetPosition: { color: colors.muted, fontSize: 13, fontWeight: "800", textAlign: "center", width: 20 },
  queueSheetText: { flex: 1 },
  queueRowTitle: { color: colors.ink, fontSize: 15, fontWeight: "700", lineHeight: 20 },
  queueOpenButton: { alignItems: "center", borderRadius: 10, flexDirection: "row", gap: 5, justifyContent: "center", minHeight: 44, paddingHorizontal: 10 },
  queueOpenButtonText: { color: colors.signal, fontSize: 14, fontWeight: "800" },
  queueBulkBlock: { marginBottom: 8, marginTop: 12 },
  queueBulkLabel: { color: colors.body, fontSize: 13, fontWeight: "700" },
  queueBulkHint: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 6 },
  queueBulkRow: { flexDirection: "row", flexWrap: "wrap", gap: 8, justifyContent: "flex-start", marginTop: 6 },
  queueBulkButton: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    flexBasis: 44,
    flexDirection: "row",
    flexGrow: 1,
    gap: 6,
    justifyContent: "center",
    maxWidth: 72,
    minHeight: 44,
    minWidth: 44,
    paddingHorizontal: 6,
    paddingVertical: 8,
  },
  queueBulkButtonLabel: { color: colors.ink, fontSize: 13, fontWeight: "700" },
  keyboardShortcut: { color: colors.muted, fontSize: 11, fontWeight: "800", lineHeight: 14 },
  queuePanel: { backgroundColor: colors.surface, borderColor: colors.separator, borderRadius: 16, borderWidth: 1, marginTop: 12, padding: 16 },
  queuePanelHeader: { alignItems: "center", flexDirection: "row", justifyContent: "space-between" },
  queuePanelHeading: { alignItems: "center", flexDirection: "row", gap: 10 },
  queuePanelIcon: { alignItems: "center", backgroundColor: colors.signalSoft, borderRadius: 12, height: 40, justifyContent: "center", width: 40 },
  queuePanelTitle: { color: colors.ink, fontSize: 17, fontWeight: "800" },
  queuePanelSubtitle: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 1 },
  queuePanelCollapse: { alignItems: "center", justifyContent: "center", minHeight: 44, minWidth: 44 },
  queuePanelEmpty: { alignItems: "center", flexDirection: "row", gap: 10, marginTop: 18, paddingVertical: 6 },
  queuePanelEmptyText: { color: colors.muted, flex: 1, fontSize: 14, lineHeight: 20 },
  queuePanelList: { marginTop: 6 },
  queuePanelMoreButton: { alignItems: "center", flexDirection: "row", gap: 6, justifyContent: "center", minHeight: 44, marginTop: 4 },
  queuePanelMore: { color: colors.signal, fontSize: 14, fontWeight: "800" },
  queueSectionHeader: { alignItems: "center", flexDirection: "row", gap: 8, marginBottom: 8, marginTop: 24 },
  queueSectionHeaderText: { color: colors.ink, fontSize: 15, fontWeight: "700" },
  catalogReviewNotice: {
    alignItems: "flex-start",
    backgroundColor: colors.signalSoft,
    borderRadius: 12,
    flexDirection: "row",
    gap: 10,
    marginTop: 14,
    paddingHorizontal: 14,
    paddingVertical: 12,
  },
  catalogReviewNoticeText: { color: colors.muted, flex: 1, fontSize: 14, lineHeight: 20 },
  gmailDetected: { color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 8 },
  gmailReviewSection: { marginBottom: 18 },
  gmailWhy: { alignSelf: "flex-start", justifyContent: "center", minHeight: 44 },
  gmailWhyText: { color: colors.signal, fontSize: 14, fontWeight: "700" },
  gmailReviewRow: { borderTopColor: colors.separator, borderTopWidth: 1, marginTop: 14, paddingTop: 14 },
  gmailSubject: { color: colors.ink, fontSize: 16, fontWeight: "700", lineHeight: 22 },
  gmailMetadata: { color: colors.muted, fontSize: 13, lineHeight: 18, marginTop: 3 },
  gmailCandidate: { alignItems: "center", flexDirection: "row", minHeight: 52, paddingVertical: 8 },
  gmailCandidateCopy: { flex: 1, paddingRight: 12 },
  gmailDismiss: { alignItems: "center", justifyContent: "center", minHeight: 48 },
  gmailDismissText: { color: colors.danger, fontSize: 15, fontWeight: "700" },
  gmailConnection: { borderTopColor: colors.separator, borderTopWidth: 1, marginTop: 16, paddingTop: 16 },
  gmailConnectionHeading: { alignItems: "center", flexDirection: "row", marginBottom: 12 },
  gmailConnectionCopy: { flex: 1, paddingLeft: 12 },
  errorText: { color: colors.danger, fontSize: 14, lineHeight: 20, marginBottom: 12 },
  buttonGap: { height: 12 },
  spacer: { height: 24 },
  gate: { flex: 1, justifyContent: "flex-start", maxWidth: 760, paddingTop: 32, width: "100%" },
  gateTitle: {
    color: colors.ink,
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.7,
  },
  gateBenefit: { color: colors.ink, fontSize: 16, fontWeight: "700" },
  gateBenefitCopy: { color: colors.muted, fontSize: 15, lineHeight: 22, marginTop: 6 },
  gateButton: { alignSelf: "stretch", marginTop: 24 },
  authScreen: { flex: 1, backgroundColor: colors.canvas },
  authKeyboard: { flex: 1 },
  authContent: {
    flexGrow: 1,
    justifyContent: "flex-start",
    paddingHorizontal: 20,
    paddingTop: 32,
    paddingBottom: 32,
  },
  authBrand: { alignItems: "flex-start", marginBottom: 28 },
  authName: {
    color: colors.ink,
    fontSize: 28,
    fontWeight: "800",
    letterSpacing: -0.6,
  },
  authTagline: { color: colors.muted, fontSize: 16, lineHeight: 23, marginTop: 8 },
  authCard: { padding: 0 },
  authTitle: {
    color: colors.ink,
    fontSize: 20,
    fontWeight: "700",
    letterSpacing: -0.3,
  },
  authDescription: {
    color: colors.muted,
    fontSize: 15,
    lineHeight: 21,
    marginTop: 6,
    marginBottom: 22,
  },
  inputLabel: {
    color: colors.body,
    fontSize: 13,
    fontWeight: "700",
    marginBottom: 7,
  },
  authInput: {
    borderColor: colors.border,
    borderWidth: 1,
    borderRadius: 10,
    color: colors.ink,
    fontSize: 16,
    minHeight: 52,
    paddingHorizontal: 14,
    marginBottom: 16,
    backgroundColor: colors.surface,
  },
  consentGroup: { gap: 12, marginBottom: 16 },
  consentRow: { alignItems: "flex-start", flexDirection: "row", gap: 10 },
  consentBox: {
    alignItems: "center",
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 5,
    borderWidth: 1,
    height: 22,
    justifyContent: "center",
    width: 22,
  },
  consentBoxChecked: { backgroundColor: colors.ink, borderColor: colors.ink },
  consentMark: { color: colors.onDark, fontSize: 15, fontWeight: "800" },
  consentText: { color: colors.body, flex: 1, fontSize: 14, lineHeight: 20 },
  policyLinks: { flexDirection: "row", gap: 8, marginLeft: 32 },
  policyLink: { color: colors.signal, fontSize: 14, fontWeight: "700" },
  policySeparator: { color: colors.muted, fontSize: 14 },
  authButton: {
    minHeight: 52,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.ink,
    marginTop: 4,
  },
  authButtonSecondary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
    marginTop: 12,
  },
  authButtonDisabled: { opacity: 0.55 },
  authButtonText: { color: colors.onDark, fontSize: 16, fontWeight: "700" },
  authButtonTextSecondary: { color: colors.body },
  authFootnote: {
    color: colors.muted,
    fontSize: 12,
    lineHeight: 17,
    textAlign: "left",
    marginTop: 20,
  },
  actionButton: {
    minHeight: 52,
    borderRadius: 10,
    alignItems: "center",
    justifyContent: "center",
    backgroundColor: colors.ink,
  },
  actionButtonSecondary: {
    backgroundColor: colors.surface,
    borderWidth: 1,
    borderColor: colors.border,
  },
  actionButtonDanger: { backgroundColor: colors.danger },
  actionButtonCompact: { minHeight: 48, marginTop: 16 },
  actionButtonTight: { marginTop: 0 },
  actionButtonGrow: { flex: 1 },
  actionButtonDisabled: { opacity: 0.55 },
  actionButtonLabel: { alignItems: "center", flexDirection: "row", gap: 7, justifyContent: "center", paddingHorizontal: 12 },
  actionButtonText: { color: colors.onDark, fontSize: 16, fontWeight: "700" },
  actionButtonTextSecondary: { color: colors.body },
  employerRoot: { backgroundColor: "#F7F7F4", flex: 1 },
  employerShell: { flex: 1 },
  employerShellWide: { flexDirection: "row" },
  employerNav: {
    backgroundColor: colors.surface,
    borderBottomColor: colors.separator,
    borderBottomWidth: 1,
    flexDirection: "row",
    paddingHorizontal: 16,
  },
  employerNavCompact: { flexWrap: "wrap", paddingBottom: 8, paddingTop: 14 },
  employerNavWide: {
    alignSelf: "stretch",
    borderBottomWidth: 0,
    borderRightColor: colors.separator,
    borderRightWidth: 1,
    flexDirection: "column",
    paddingHorizontal: 18,
    paddingVertical: 28,
    width: 244,
  },
  employerBrandBlock: { marginBottom: 18, marginRight: 24, minWidth: 150 },
  employerBrandBlockCompact: { marginBottom: 8, width: "100%" },
  employerWordmark: { color: colors.ink, fontSize: 18, fontWeight: "800", letterSpacing: -0.3 },
  employerWorkspaceLabel: { color: colors.muted, fontSize: 12, marginTop: 3 },
  employerNavItem: {
    justifyContent: "center",
    minHeight: 50,
    paddingHorizontal: 12,
  },
  employerNavItemActive: { backgroundColor: colors.signalSoft, borderRadius: 10 },
  employerNavText: { color: colors.muted, fontSize: 14, fontWeight: "700" },
  employerNavTextActive: { color: colors.signal },
  employerSignOut: { justifyContent: "center", minHeight: 48, paddingHorizontal: 12 },
  employerSignOutText: { color: colors.muted, fontSize: 14, fontWeight: "700" },
  employerMain: { flex: 1 },
  employerContent: { alignSelf: "center", maxWidth: 860, paddingHorizontal: 24, paddingVertical: 42, width: "100%" },
  employerPageTitle: { color: colors.ink, fontSize: 36, fontWeight: "800", letterSpacing: -1, lineHeight: 42 },
  employerIntro: { color: colors.muted, fontSize: 16, lineHeight: 24, marginBottom: 30, marginTop: 8, maxWidth: 640 },
  employerSection: { gap: 14 },
  employerSectionTitle: { color: colors.ink, fontSize: 20, fontWeight: "700", lineHeight: 27, marginTop: 26 },
  employerHelp: { color: colors.muted, fontSize: 14, lineHeight: 20 },
  employerNotice: { backgroundColor: colors.surface, borderRadius: 10, color: colors.body, fontSize: 14, lineHeight: 20, marginBottom: 18, padding: 14 },
  employerError: { backgroundColor: colors.dangerSoft, color: colors.danger },
  employerSuccess: { backgroundColor: colors.successSoft, color: "#17633A" },
  employerEmpty: { color: colors.muted, fontSize: 15, lineHeight: 22, paddingVertical: 18 },
  employerRow: {
    alignItems: "flex-start",
    borderBottomColor: colors.separator,
    borderBottomWidth: 1,
    flexDirection: "row",
    gap: 18,
    justifyContent: "space-between",
    paddingVertical: 16,
  },
  employerRowCopy: { flex: 1, minWidth: 0 },
  employerRowCompact: { flexDirection: "column" },
  employerRowTitle: { color: colors.ink, fontSize: 16, fontWeight: "700", lineHeight: 22 },
  employerUrl: { color: colors.signal, fontSize: 13, lineHeight: 19, marginTop: 4 },
  employerInlineAction: { alignSelf: "flex-start", justifyContent: "center", minHeight: 44, paddingRight: 12 },
  employerInlineActionText: { color: colors.signal, fontSize: 14, fontWeight: "700" },
  employerInlineActionDanger: { color: colors.danger, fontSize: 14, fontWeight: "700" },
  employerStatus: { backgroundColor: "#EEF1F4", borderRadius: 10, maxWidth: 300, paddingHorizontal: 12, paddingVertical: 10 },
  employerStatusDanger: { backgroundColor: colors.dangerSoft },
  employerStatusWarning: { backgroundColor: "#FFF5D9" },
  employerStatusPositive: { backgroundColor: colors.successSoft },
  employerStatusLabel: { color: colors.ink, fontSize: 13, fontWeight: "800" },
  employerStatusText: { color: colors.body, fontSize: 12, lineHeight: 17, marginTop: 3 },
  employerField: { marginTop: 2 },
  employerInput: {
    backgroundColor: colors.surface,
    borderColor: colors.border,
    borderRadius: 10,
    borderWidth: 1,
    color: colors.ink,
    fontSize: 16,
    minHeight: 50,
    paddingHorizontal: 14,
  },
  employerInputMultiline: { minHeight: 92, paddingTop: 13, textAlignVertical: "top" },
  employerFieldGrid: { flexDirection: "row", flexWrap: "wrap", gap: 14 },
  employerGridItem: { width: "48%" },
  employerEvidence: { backgroundColor: colors.surface, borderRadius: 12, padding: 16 },
  employerCode: { color: colors.ink, fontFamily: Platform.OS === "web" ? "monospace" : undefined, fontSize: 15, marginBottom: 10 },
  employerAuth: { alignSelf: "center", maxWidth: 520, paddingHorizontal: 24, paddingTop: 54, width: "100%" },
});
