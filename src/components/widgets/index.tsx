import type { CanvasWidget } from '../../types/canvas';
import { WidgetWrapper } from './WidgetWrapper';
import { ButtonWidget } from './ButtonWidget';
import { TitleFieldWidget } from './TitleFieldWidget';
import { FilePathWidget } from './FilePathWidget';
import { ScoreboardWidget } from './ScoreboardWidget';
import { ScoreLogWidget } from './ScoreLogWidget';
import { ScoreLowerThirdWidget } from './ScoreLowerThirdWidget';
import { PlayerLowerThirdWidget } from './PlayerLowerThirdWidget';
import { SinBinLowerThirdWidget } from './SinBinLowerThirdWidget';
import { TimerWidget } from './TimerWidget';
import { TBarWidget } from './TBarWidget';
import { VolumeWidget } from './VolumeWidget';
import { OverlayWidget } from './OverlayWidget';
import { LabelWidget } from './LabelWidget';
import { InputTallyWidget } from './InputTallyWidget';
import { TransitionsWidget } from './TransitionsWidget';
import { TimelineWidget } from './TimelineWidget';
import { PlayerListWidget } from './PlayerListWidget';
import { SubWidget } from './SubWidget';
import { CardDisplayWidget } from './CardDisplayWidget';
import { NdiInputWidget } from './NdiInputWidget';
import { PanelWidget } from './PanelWidget';
import { VmixTitlesWidget } from './VmixTitlesWidget';
import { RugbyLineupWidget } from './RugbyLineupWidget';
import { CardLowerThirdWidget } from './CardLowerThirdWidget';
import { PomodoroWidget } from './PomodoroWidget';
import { ImageDisplayWidget } from './ImageDisplayWidget';
import { RecentMatchesWidget } from './RecentMatchesWidget';
import { MatchScheduleWidget } from './MatchScheduleWidget';

interface Props {
  widget: CanvasWidget;
}

export function WidgetRenderer({ widget }: Props) {
  const { id, type, config, w, h } = widget;
  const sharedProps = { config, w, h };

  let content: React.ReactNode;

  switch (type) {
    case 'button':      content = <ButtonWidget {...sharedProps} />; break;
    case 'title-field': content = <TitleFieldWidget {...sharedProps} />; break;
    case 'file-path':   content = <FilePathWidget widgetId={id} {...sharedProps} />; break;
    case 'scoreboard':  content = <ScoreboardWidget widgetId={id} {...sharedProps} />; break;
    case 'score-log':          content = <ScoreLogWidget widgetId={id} {...sharedProps} />; break;
    case 'score-lower-third':      content = <ScoreLowerThirdWidget widgetId={id} {...sharedProps} />; break;
    case 'player-lower-third':     content = <PlayerLowerThirdWidget widgetId={id} {...sharedProps} />; break;
    case 'sin-bin-lower-third':    content = <SinBinLowerThirdWidget widgetId={id} {...sharedProps} />; break;
    case 'timer':       content = <TimerWidget widgetId={id} {...sharedProps} />; break;
    case 'tbar':        content = <TBarWidget {...sharedProps} />; break;
    case 'volume':      content = <VolumeWidget {...sharedProps} />; break;
    case 'overlay':     content = <OverlayWidget {...sharedProps} />; break;
    case 'label':       content = <LabelWidget {...sharedProps} />; break;
    case 'input-tally': content = <InputTallyWidget {...sharedProps} />; break;
    case 'transitions': content = <TransitionsWidget {...sharedProps} />; break;
    case 'timeline':    content = <TimelineWidget widgetId={id} {...sharedProps} />; break;
    case 'player-list':  content = <PlayerListWidget widgetId={id} {...sharedProps} />; break;
    case 'substitution':  content = <SubWidget widgetId={id} {...sharedProps} />; break;
    case 'card-display':  content = <CardDisplayWidget {...sharedProps} />; break;
    case 'ndi-input':     content = <NdiInputWidget widgetId={id} {...sharedProps} />; break;
    case 'panel':         content = <PanelWidget {...sharedProps} />; break;
    case 'vmix-titles':   content = <VmixTitlesWidget {...sharedProps} />; break;
    case 'rugby-lineup':       content = <RugbyLineupWidget widgetId={id} {...sharedProps} />; break;
    case 'card-lower-third':   content = <CardLowerThirdWidget widgetId={id} {...sharedProps} />; break;
    case 'pomodoro':           content = <PomodoroWidget {...sharedProps} />; break;
    case 'image-display':      content = <ImageDisplayWidget config={config} />; break;
    case 'recent-matches':     content = <RecentMatchesWidget {...sharedProps} />; break;
    case 'match-schedule':     content = <MatchScheduleWidget widgetId={id} {...sharedProps} />; break;
    default:            content = <div style={{ padding: 8, fontSize: 11 }}>Unknown widget</div>;
  }

  return (
    <WidgetWrapper widget={widget}>
      {content}
    </WidgetWrapper>
  );
}
