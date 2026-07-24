import type { LucideIcon } from 'lucide-react';
import {
  Zap, FileText, FolderOpen, Trophy, ClipboardList, PanelBottom,
  Star, AlertOctagon, CalendarDays, Shirt, ArrowLeftRight, CreditCard,
  Timer, SlidersHorizontal, Volume2, Layers, Tag, Radio,
  Repeat2, Video, LayoutGrid, AlignLeft, Shield, Square,
  Clock, List, Image, ListOrdered, CalendarClock, BarChart3, Network, TrendingUp,
  Swords, IdCard,
} from 'lucide-react';
import type { WidgetType } from '../../types/canvas';

const ICON_MAP: Record<WidgetType, LucideIcon> = {
  'button':              Zap,
  'title-field':         FileText,
  'file-path':           FolderOpen,
  'scoreboard':          Trophy,
  'score-log':           ClipboardList,
  'score-lower-third':   PanelBottom,
  'player-lower-third':  Star,
  'sin-bin-lower-third': AlertOctagon,
  'timeline':            CalendarDays,
  'player-list':         Shirt,
  'substitution':        ArrowLeftRight,
  'card-display':        CreditCard,
  'timer':               Timer,
  'tbar':                SlidersHorizontal,
  'volume':              Volume2,
  'overlay':             Layers,
  'label':               Tag,
  'input-tally':         Radio,
  'transitions':         Repeat2,
  'ndi-input':           Video,
  'panel':               LayoutGrid,
  'vmix-titles':         AlignLeft,
  'rugby-lineup':        Shield,
  'card-lower-third':    Square,
  'pomodoro':            Clock,
  'image-display':       Image,
  'recent-matches':      ListOrdered,
  'match-schedule':      CalendarClock,
  'standings':           BarChart3,
  'bracket':             Network,
  'team-form':           TrendingUp,
  'player-h2h':          Swords,
  'player-stats':        IdCard,
};

interface Props {
  type: WidgetType;
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export function WidgetIcon({ type, size = 16, strokeWidth = 2, className }: Props) {
  const Icon: LucideIcon = ICON_MAP[type] ?? List;
  return <Icon size={size} strokeWidth={strokeWidth} className={className} />;
}
