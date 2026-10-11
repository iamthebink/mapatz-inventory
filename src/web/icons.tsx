import type { ComponentType, SVGProps } from 'react';
import {
  ArchiveIcon,
  ArrowCounterClockwiseIcon,
  ArrowDownIcon,
  ArrowUUpLeftIcon,
  ArrowUpIcon,
  ArrowsClockwiseIcon,
  ArrowsDownUpIcon,
  BookBookmarkIcon,
  CalendarDotsIcon,
  CaretDownIcon,
  CheckCircleIcon,
  CheckIcon,
  ClipboardTextIcon,
  DownloadSimpleIcon,
  EyeIcon,
  EyeSlashIcon,
  KeyIcon,
  MagnifyingGlassIcon,
  MapPinIcon,
  NoteIcon,
  PackageIcon,
  PencilSimpleIcon,
  QuestionIcon,
  RadioIcon,
  RobotIcon,
  ShieldCheckIcon,
  ShippingContainerIcon,
  SlidersHorizontalIcon,
  TrashIcon,
  UploadSimpleIcon,
  UserPlusIcon,
  UsersIcon,
  WarningIcon,
  XCircleIcon,
  XIcon,
  type Icon as PhosphorIcon,
} from '@phosphor-icons/react';

export type IconProps = SVGProps<SVGSVGElement> & { size?: number | string };
export type AppIcon = ComponentType<IconProps>;

// Keep every bundled icon regular and decorative, including inside icon-only labeled buttons.
function regular(Icon: PhosphorIcon): AppIcon {
  return function RegularIcon(props: IconProps) {
    return <Icon {...props} weight="regular" aria-hidden="true" focusable="false" />;
  };
}

export const Archive = regular(ArchiveIcon);
export const BookOpen = regular(BookBookmarkIcon);
export const Boxes = regular(ShippingContainerIcon);
export const ClipboardList = regular(ClipboardTextIcon);
export const Download = regular(DownloadSimpleIcon);
export const Eye = regular(EyeIcon);
export const EyeOff = regular(EyeSlashIcon);
export const KeyRound = regular(KeyIcon);
export const CalendarDays = regular(CalendarDotsIcon);
export const Pencil = regular(PencilSimpleIcon);
export const Radio = regular(RadioIcon);
export const RotateCcw = regular(ArrowCounterClockwiseIcon);
export const Settings2 = regular(SlidersHorizontalIcon);
export const ShieldCheck = regular(ShieldCheckIcon);
export const Trash2 = regular(TrashIcon);
export const Upload = regular(UploadSimpleIcon);
export const UserPlus = regular(UserPlusIcon);
export const Users = regular(UsersIcon);
export const Check = regular(CheckIcon);
export const ClipboardCheck = regular(ClipboardTextIcon);
export const PackageMinus = regular(PackageIcon);
export const RefreshCw = regular(ArrowsClockwiseIcon);
export const Undo2 = regular(ArrowUUpLeftIcon);
export const TriangleAlert = regular(WarningIcon);
export const StickyNote = regular(NoteIcon);
export const X = regular(XIcon);
export const CheckCircle2 = regular(CheckCircleIcon);
export const CircleX = regular(XCircleIcon);
export const ChevronDown = regular(CaretDownIcon);
export const CircleCheck = regular(CheckCircleIcon);
export const CircleHelp = regular(QuestionIcon);
export const SearchCheck = regular(MagnifyingGlassIcon);
export const MapPin = regular(MapPinIcon);
export const ArrowDown = regular(ArrowDownIcon);
export const ArrowUp = regular(ArrowUpIcon);
export const ArrowUpDown = regular(ArrowsDownUpIcon);
export const Search = regular(MagnifyingGlassIcon);
export const Robot = regular(RobotIcon);

export function BeerTap({ size = 24, ...props }: IconProps) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <g stroke="currentColor" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round">
        <path d="M32 216h72M48 208v-96a32 32 0 0 1 32-32h88a24 24 0 0 1 24 24v16h-32v-8H88v96" />
        <rect x="80" y="24" width="32" height="48" rx="8" />
        <path d="M96 72v8M144 152h56v56a16 16 0 0 1-16 16h-24a16 16 0 0 1-16-16zM200 160h8a16 16 0 0 1 0 32h-8" />
      </g>
    </svg>
  );
}

export function Monkey({ size = 24, ...props }: IconProps) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <path
        d="M48 100C8 80 0 152 44 156M208 100c40-20 48 52 4 56"
        fill="none"
        stroke="currentColor"
        strokeWidth="16"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <g stroke="currentColor" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round">
        <circle cx="128" cy="128" r="88" />
        <path d="M128 92C104 60 64 80 64 116M128 92c24-32 64-12 64 24M112 176q16 16 32 0" />
      </g>
      <g fill="currentColor">
        <circle cx="100" cy="124" r="9" />
        <circle cx="156" cy="124" r="9" />
        <ellipse cx="128" cy="151" rx="11" ry="7" />
      </g>
    </svg>
  );
}

export function Camel({ size = 24, ...props }: IconProps) {
  return (
    <svg
      {...props}
      width={size}
      height={size}
      viewBox="0 0 256 256"
      fill="none"
      aria-hidden="true"
      focusable="false"
    >
      <g stroke="currentColor" strokeWidth="16" strokeLinecap="round" strokeLinejoin="round">
        <path d="M40 120C48 120 48 72 68 72S88 112 100 112 112 72 132 72 148 120 164 120C184 120 180 88 180 56c0-16 20-16 28-8l28 12q8 4 4 16t-16 12h-16c0 48-12 80-40 80H56q-24 0-24-24 0-16 8-24Z" />
        <path d="M52 168l-8 56M80 168l8 56M140 168l-8 56M168 168l12 56M32 136q-16 0-16 24M188 44l-8-16" />
      </g>
      <circle cx="208" cy="64" r="5" fill="currentColor" />
    </svg>
  );
}
