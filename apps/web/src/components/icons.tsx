/**
 * Inline stroke icons in the screens kit's style (24-unit box, 1.8 stroke). Decorative by default:
 * the control that holds one carries the accessible name.
 */
import type { SVGProps } from 'react';

type IconProps = SVGProps<SVGSVGElement>;

function Svg({ children, ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
      {...props}
    >
      {children}
    </svg>
  );
}

export const ChevronDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m6 9 6 6 6-6" />
  </Svg>
);

export const CheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </Svg>
);

/** Lucide's arrow-up-down: the list's Display button (D211). */
export const ArrowUpDownIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m21 16-4 4-4-4" />
    <path d="M17 20V4" />
    <path d="m3 8 4-4 4 4" />
    <path d="M7 4v16" />
  </Svg>
);

export const XIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 6l12 12M18 6 6 18" />
  </Svg>
);

export const EyeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12Z" />
    <circle cx="12" cy="12" r="3" />
  </Svg>
);

export const EyeOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10.6 5.6A9.6 9.6 0 0 1 12 5.5c6 0 9.5 6.5 9.5 6.5a16 16 0 0 1-2.9 3.6M6.4 6.4C3.9 8 2.5 12 2.5 12S6 18.5 12 18.5a9 9 0 0 0 5.6-1.9" />
    <path d="M9.9 9.9a3 3 0 0 0 4.2 4.2M3 3l18 18" />
  </Svg>
);

/** The assistant: a speech bubble with a question mark (D134). Never sparkles. */
export const AssistantIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 4.5h14a1.5 1.5 0 0 1 1.5 1.5v9a1.5 1.5 0 0 1-1.5 1.5h-6.5L8 20v-3.5H5A1.5 1.5 0 0 1 3.5 15V6A1.5 1.5 0 0 1 5 4.5Z" />
    <path d="M9.8 9.2a2.2 2.2 0 1 1 3 2.1c-.6.3-.8.6-.8 1.2M12 14.9v.01" />
  </Svg>
);

/** Dictation (D25): the composer's and Capture's name field's mic. */
export const MicIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="9" y="3.5" width="6" height="11" rx="3" />
    <path d="M5.5 11.5a6.5 6.5 0 0 0 13 0M12 18v2.5" />
  </Svg>
);

export const InfoIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 11v5M12 8v.01" />
  </Svg>
);

export const AlertIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 4 21 19.5H3Z" />
    <path d="M12 10v4.5M12 17v.01" />
  </Svg>
);

// ----- navigation (paths from docs/design/screens/_skeleton.html) ------------------------------

export const HomeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 11 12 4l8 7v8a1 1 0 0 1-1 1h-4v-6H9v6H5a1 1 0 0 1-1-1Z" />
  </Svg>
);

export const SearchIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="11" cy="11" r="6" />
    <path d="m20 20-4.5-4.5" />
  </Svg>
);

export const CameraIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 8h3l2-3h6l2 3h3v11H4Z" />
    <circle cx="12" cy="13" r="3.5" />
  </Svg>
);

export const InboxIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 13h4l2 3h4l2-3h4" />
    <path d="M5 13 7 5h10l2 8v6H5Z" />
  </Svg>
);

export const MenuIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 7h14M5 12h14M5 17h14" />
  </Svg>
);

export const BellIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 16V11a6 6 0 1 1 12 0v5l1.5 2h-15Z" />
    <path d="M10 20a2 2 0 0 0 4 0" />
  </Svg>
);

/** Points to the inline end, so it mirrors in RTL (`rtl:-scale-x-100`). */
export const ChevronEndIcon = ({ className, ...p }: IconProps) => (
  <Svg className={`rtl:-scale-x-100 ${className ?? ''}`} {...p}>
    <path d="m9 6 6 6-6 6" />
  </Svg>
);

/** Points to the inline start (back, previous); mirrors in RTL. */
export const ChevronStartIcon = ({ className, ...p }: IconProps) => (
  <Svg className={`rtl:-scale-x-100 ${className ?? ''}`} {...p}>
    <path d="m15 6-6 6 6 6" />
  </Svg>
);

export const PlusIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 5v14M5 12h14" />
  </Svg>
);

// ----- things and places -----------------------------------------------------------------------

export const BuildingIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M5 20V5a1 1 0 0 1 1-1h8a1 1 0 0 1 1 1v15M15 9h3a1 1 0 0 1 1 1v10M3.5 20h17" />
    <path d="M8.5 8h3M8.5 11.5h3M8.5 15h3" />
  </Svg>
);

export const HouseIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 10.5 12 4l8 6.5M6 9v11h12V9" />
    <path d="M10 20v-5h4v5" />
  </Svg>
);

export const GarageIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 20V9L12 4l8.5 5v11" />
    <path d="M7 20v-8h10v8M7 15h10" />
  </Svg>
);

export const BoxIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 3.5 8 4v9l-8 4-8-4v-9Z" />
    <path d="m4 7.5 8 4 8-4M12 11.5v9" />
  </Svg>
);

export const BriefcaseIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="7.5" width="17" height="12" rx="1.5" />
    <path d="M9 7.5V5.5a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2M3.5 12.5h17" />
  </Svg>
);

export const PalmIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 21V10M12 10C10 6 6 5.5 3.5 7M12 10c2-4 6-4.5 8.5-3M12 10c-2.5-1-6 0-7 3.5M12 10c2.5-1 6 0 7 3.5" />
  </Svg>
);

export const PersonIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="8.5" r="3.5" />
    <path d="M5 20a7 7 0 0 1 14 0" />
  </Svg>
);

export const PeopleIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="9" cy="9" r="3" />
    <path d="M3.5 19a5.5 5.5 0 0 1 11 0M15.5 6.2a3 3 0 0 1 0 5.6M17.5 14.2A5.5 5.5 0 0 1 20.5 19" />
  </Svg>
);

export const LockIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="10.5" width="14" height="9.5" rx="1.5" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </Svg>
);

export const LinkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1" />
    <path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1" />
  </Svg>
);

export const CopyIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="8.5" y="8.5" width="11" height="11" rx="1.5" />
    <path d="M15.5 8.5V6A1.5 1.5 0 0 0 14 4.5H6A1.5 1.5 0 0 0 4.5 6v8A1.5 1.5 0 0 0 6 15.5h2.5" />
  </Svg>
);

export const ShareIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 15V4M8 7.5 12 4l4 3.5" />
    <path d="M7 10.5H6A1.5 1.5 0 0 0 4.5 12v6.5A1.5 1.5 0 0 0 6 20h12a1.5 1.5 0 0 0 1.5-1.5V12a1.5 1.5 0 0 0-1.5-1.5h-1" />
  </Svg>
);

export const MailIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3.5" y="5.5" width="17" height="13" rx="1.5" />
    <path d="m4 7 8 6 8-6" />
  </Svg>
);

export const CalendarIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="5.5" width="16" height="14.5" rx="1.5" />
    <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4" />
  </Svg>
);

export const ClockIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </Svg>
);

export const ShieldIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5 19 6v5.5c0 4.2-3 7.6-7 9-4-1.4-7-4.8-7-9V6Z" />
  </Svg>
);

export const ShieldCheckIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M12 3.5 19 6v5.5c0 4.2-3 7.6-7 9-4-1.4-7-4.8-7-9V6Z" />
    <path d="m9 12 2.2 2.2L15.5 10" />
  </Svg>
);

export const LeaveIcon = ({ className, ...p }: IconProps) => (
  <Svg className={`rtl:-scale-x-100 ${className ?? ''}`} {...p}>
    <path d="M14 4.5h4a1.5 1.5 0 0 1 1.5 1.5v12a1.5 1.5 0 0 1-1.5 1.5h-4" />
    <path d="M10 8 6 12l4 4M6 12h9" />
  </Svg>
);

export const RetryIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3" />
    <path d="M19.5 4.5v4h-4" />
  </Svg>
);

export const KeyIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="8" cy="15" r="4" />
    <path d="m11 12 8.5-8.5M16 7l2.5 2.5M14 9l2 2" />
  </Svg>
);

export const LaptopIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="5" y="5" width="14" height="10" rx="1.5" />
    <path d="M3 19h18" />
  </Svg>
);

export const PhoneIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="7" y="3.5" width="10" height="17" rx="2" />
    <path d="M11 17.5h2" />
  </Svg>
);

export const CheckCircleIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m8.5 12.2 2.4 2.4 4.6-4.8" />
  </Svg>
);

export const GripIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 6v.01M15 6v.01M9 12v.01M15 12v.01M9 18v.01M15 18v.01" strokeWidth="2.6" />
  </Svg>
);

export const GearIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="3" />
    <path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M18 6l-1.6 1.6M7.6 16.4 6 18M18 18l-1.6-1.6M7.6 7.6 6 6" />
  </Svg>
);

export const ServerIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="4.5" width="16" height="6.5" rx="1.5" />
    <rect x="4" y="13" width="16" height="6.5" rx="1.5" />
    <path d="M8 7.75v.01M8 16.25v.01" strokeWidth="2.4" />
  </Svg>
);

export const QrIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="4" width="6" height="6" rx="1" />
    <rect x="14" y="4" width="6" height="6" rx="1" />
    <rect x="4" y="14" width="6" height="6" rx="1" />
    <path d="M14 14h2.5v2.5M20 14v.01M14 20h2.5M20 17.5V20h-2" />
  </Svg>
);

/** The board's print glyph (screens board `a2-print`): label sheets. */
export const PrinterIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 9V3h10v6M7 17H4v-7h16v7h-3" />
    <path d="M7 14h10v7H7Z" />
  </Svg>
);

export const WrenchIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5Z" />
  </Svg>
);

export const CarIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 16v-4l2-5h12l2 5v4M4 16h16v2.5M4 16v2.5M3.5 12h17" />
    <path d="M7.5 14v.01M16.5 14v.01" strokeWidth="2.4" />
  </Svg>
);

export const TrashIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13" />
  </Svg>
);

export const ActivityIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 12h4l2.5-6 4 12 2.5-6h4" />
  </Svg>
);

export const HelpIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.6 9.6a2.4 2.4 0 1 1 3.2 2.3c-.6.3-.8.6-.8 1.3M12 16.2v.01" />
  </Svg>
);

export const ChartIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20V4M4 20h16M8 16v-4M12 16V8M16 16v-6" />
  </Svg>
);

export const DocumentIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6 3.5h8l4 4V20a.5.5 0 0 1-.5.5h-11A.5.5 0 0 1 6 20Z" />
    <path d="M14 3.5v4h4M9 12h6M9 15.5h6" />
  </Svg>
);

export const HandoffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 12h12M12 8l4 4-4 4M20 5v14" />
  </Svg>
);

export const ScheduleIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="4" y="5.5" width="16" height="14.5" rx="1.5" />
    <path d="M4 10h16M8.5 3.5v4M15.5 3.5v4M9 14.5l2 2 4-4" />
  </Svg>
);

export const LogoutIcon = LeaveIcon;

// ----- step 2: status pills and places --------------------------------------------------------

/** Uncertain location (D40): a circle with a question mark. */
export const QuestionIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M9.6 9.4a2.5 2.5 0 1 1 3.4 2.3c-.7.3-1 .7-1 1.4M12 16v.01" />
  </Svg>
);

/** A draft awaiting review: a pencil. */
export const PencilIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17Z" />
    <path d="m14.5 7.5 3 3" />
  </Svg>
);

/** A lifecycle that has ended (sold, given away, lost…): a circle with a stroke through it. */
export const EndedIcon = (p: IconProps) => (
  <Svg {...p}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="m6 18 12-12" />
  </Svg>
);

/** The source code link (D147) in the sidebar rail: angle brackets. */
export const CodeIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m8.5 7-5 5 5 5M15.5 7l5 5-5 5" />
  </Svg>
);

/** Collapse the sidebar (D198): a panel with a chevron to the inline start; mirrors in RTL. */
export const PanelCollapseIcon = ({ className, ...p }: IconProps) => (
  <Svg className={`rtl:-scale-x-100 ${className ?? ''}`} {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M9 4.5v15M15.5 9.5 13 12l2.5 2.5" />
  </Svg>
);

/** Expand the sidebar (D198): the same panel, the chevron to the inline end; mirrors in RTL. */
export const PanelExpandIcon = ({ className, ...p }: IconProps) => (
  <Svg className={`rtl:-scale-x-100 ${className ?? ''}`} {...p}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
    <path d="M9 4.5v15M13 9.5l2.5 2.5-2.5 2.5" />
  </Svg>
);

/** "+ Filter" and "Filters (n)" (D205). */
export const FilterIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M4 5h16l-6 7.5V19l-4-2v-4.5z" />
  </Svg>
);

export const TagIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M3.5 12.1V4.5a1 1 0 0 1 1-1h7.6l8.4 8.4a1.4 1.4 0 0 1 0 2l-6 6a1.4 1.4 0 0 1-2 0z" />
    <circle cx="8" cy="8" r="1.4" />
  </Svg>
);

/** A saved view (D205). */
export const BookmarkIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M6.5 3.5h11v17L12 16.5l-5.5 4z" />
  </Svg>
);

/** A view pinned as a tab (D205). */
export const PinIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M9 3.5h6M10 3.5v6l-3 4h10l-3-4v-6M12 13.5v7" />
  </Svg>
);

/** The default view of a list (D205). */
export const StarIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="m12 3.8 2.5 5.2 5.6.7-4.1 3.9 1 5.6L12 16.5l-5 2.7 1-5.6-4.1-3.9 5.6-.7z" />
  </Svg>
);

/** The photo library (capture's Gallery, D140). */
export const GalleryIcon = (p: IconProps) => (
  <Svg {...p}>
    <rect x="3" y="5" width="18" height="14" rx="2" />
    <path d="m3 16 5-5 4 4 3-3 6 6" />
    <circle cx="16" cy="9" r="1.5" />
  </Svg>
);

/** No connection: capture's "Offline · 8 waiting to sync". */
export const CloudOffIcon = (p: IconProps) => (
  <Svg {...p}>
    <path d="M7 18h9.5a3.5 3.5 0 0 0 1-6.9A5 5 0 0 0 8.1 9 4.5 4.5 0 0 0 7 18Z" />
    <path d="M4 4l16 16" />
  </Svg>
);
