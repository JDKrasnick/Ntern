import { useEffect, useId, useRef, useState, type ComponentProps } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { RoleFactSummary } from '../../shared/posting-fact-display';
import { metadataHintPosition, type HintAnchor } from './role-metadata-hint';

const fieldStyle: Record<RoleFactSummary['field'], { icon: ComponentProps<typeof Ionicons>['name']; color: string }> = {
  compensation: { icon: 'cash-outline', color: '#067647' },
  locations: { icon: 'location-outline', color: '#0E7490' },
  workMode: { icon: 'briefcase-outline', color: '#245E9E' },
  housing: { icon: 'home-outline', color: '#8A5700' },
  timing: { icon: 'calendar-outline', color: '#6C45A8' },
  education: { icon: 'school-outline', color: '#4F46A5' },
  eligibility: { icon: 'shield-checkmark-outline', color: '#0D7568' },
};

export function RoleMetadataHints({ facts }: { facts: RoleFactSummary[] }) {
  const viewport = useWindowDimensions();
  const [hint, setHint] = useState<{ fact: RoleFactSummary; anchor: HintAnchor; hover: boolean } | null>(null);
  const [bubbleHeight, setBubbleHeight] = useState(0);
  const anchors = useRef(new Map<string, View>());
  const openTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const mounted = useRef(true);
  const requestVersion = useRef(0);
  const suppressPassiveUntil = useRef(0);
  const lastViewport = useRef({ width: viewport.width, height: viewport.height });
  const bubbleId = `metadata-hint-${useId()}`;
  const position = hint ? metadataHintPosition(hint.anchor, viewport, bubbleHeight || 180) : null;
  const cancelPendingOpen = () => {
    clearTimeout(openTimer.current);
    requestVersion.current += 1;
  };
  const dismiss = () => {
    cancelPendingOpen();
    clearTimeout(closeTimer.current);
    // Restored focus/hover after dismissing is not a new request to reopen.
    suppressPassiveUntil.current = Date.now() + 600;
    setHint(null);
  };
  const open = (fact: RoleFactSummary, hover: boolean) => {
    cancelPendingOpen();
    clearTimeout(closeTimer.current);
    const version = requestVersion.current;
    anchors.current.get(fact.field)?.measureInWindow((x, y, width, height) => {
      if (!mounted.current || requestVersion.current !== version || !width || !height) return;
      setBubbleHeight(0);
      setHint({ fact, anchor: { x, y, width, height }, hover });
    });
  };
  const delayedOpen = (fact: RoleFactSummary) => {
    cancelPendingOpen();
    if (Date.now() < suppressPassiveUntil.current) return;
    openTimer.current = setTimeout(() => open(fact, true), 450);
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      requestVersion.current += 1;
      clearTimeout(openTimer.current);
      clearTimeout(closeTimer.current);
    };
  }, []);
  useEffect(() => {
    if (lastViewport.current.width === viewport.width && lastViewport.current.height === viewport.height) return;
    lastViewport.current = { width: viewport.width, height: viewport.height };
    dismiss(); // Anchors change when rotating or resizing.
  }, [viewport.width, viewport.height]);
  useEffect(() => {
    if (Platform.OS !== 'web' || !hint || !position) return;
    const insideBubble = (target: EventTarget | null) => target instanceof Node
      && document.getElementById(bubbleId)?.contains(target);
    const scroll = (event: Event) => { if (!insideBubble(event.target)) dismiss(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); dismiss(); } };
    const move = (event: PointerEvent) => {
      if (!hint.hover || event.pointerType === 'touch') return;
      const a = hint.anchor;
      // The gap is part of the hover region, so entering the bubble does not dismiss it.
      const within = (x: number, y: number, width: number, height: number) =>
        event.clientX >= x - 12 && event.clientX <= x + width + 12
        && event.clientY >= y - 12 && event.clientY <= y + height + 12;
      if (insideBubble(event.target) || within(a.x, a.y, a.width, a.height)
        || within(position.left, position.top, position.width, bubbleHeight || 180)) {
        clearTimeout(closeTimer.current);
      } else {
        clearTimeout(closeTimer.current);
        closeTimer.current = setTimeout(dismiss, 200);
      }
    };
    window.addEventListener('scroll', scroll, true);
    window.addEventListener('keydown', key, true);
    window.addEventListener('pointermove', move);
    window.addEventListener('blur', dismiss);
    return () => {
      window.removeEventListener('scroll', scroll, true);
      window.removeEventListener('keydown', key, true);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('blur', dismiss);
      clearTimeout(closeTimer.current);
    };
  }, [hint, position?.left, position?.top, position?.width, bubbleHeight, bubbleId]);

  return <View style={hintStyles.facts}>
    <View style={hintStyles.flow}>
      {facts.map(fact => {
        const tone = fieldStyle[fact.field];
        return <View key={fact.field} style={[hintStyles.item, fact.field === 'compensation' ? hintStyles.pay : null]}><Pressable
          ref={node => { if (node) anchors.current.set(fact.field, node); else anchors.current.delete(fact.field); }}
          accessibilityRole="button"
          accessibilityLabel={`${fact.label}: ${fact.tags.join(', ')}`}
          accessibilityHint="Show details in a hint bubble"
          aria-expanded={hint?.fact.field === fact.field}
          aria-controls={hint?.fact.field === fact.field ? bubbleId : undefined}
          onPress={() => { cancelPendingOpen(); hint?.fact.field === fact.field ? dismiss() : open(fact, false); }}
          onHoverIn={() => delayedOpen(fact)} onHoverOut={cancelPendingOpen}
          onFocus={() => delayedOpen(fact)} onBlur={cancelPendingOpen}
          style={hintStyles.trigger}>
          <Ionicons name={tone.icon} size={16} color={tone.color} />
          <Text style={[hintStyles.value, fact.field === 'compensation' ? hintStyles.payText : null]}>
            {fact.field !== 'compensation' ? <Text style={[hintStyles.label, { color: tone.color }]}>{fact.label}: </Text> : null}
            {fact.tags.join(' · ')}
          </Text>
          <Ionicons name="information-circle-outline" size={12} color={tone.color} />
        </Pressable></View>;
      })}
    </View>
    <Modal visible={Boolean(hint)} transparent animationType="none" onRequestClose={dismiss} statusBarTranslucent>
      <View style={StyleSheet.absoluteFill}>
        <Pressable style={StyleSheet.absoluteFill} onPress={dismiss} accessibilityRole="button" accessibilityLabel="Dismiss metadata hint" />
        {hint && position ? <View nativeID={bubbleId} accessibilityViewIsModal role="dialog" aria-modal={true}
          accessibilityLabel={`${hint.fact.label} details`}
          onLayout={event => setBubbleHeight(event.nativeEvent.layout.height)}
          style={[hintStyles.bubble, { left: position.left, top: position.top, width: position.width,
            maxHeight: position.maxHeight, opacity: bubbleHeight ? 1 : 0 }]}>
          <View pointerEvents="none" style={[hintStyles.tail, { left: position.arrowLeft - 6 },
            position.placement === 'below' ? { top: -6 } : { bottom: -6 }]} />
          <View style={hintStyles.heading}>
            <Ionicons name={fieldStyle[hint.fact.field].icon} size={19} color={fieldStyle[hint.fact.field].color} />
            <Text style={[hintStyles.title, { color: fieldStyle[hint.fact.field].color }]}>{hint.fact.label}</Text>
            <Pressable onPress={dismiss} accessibilityRole="button" accessibilityLabel={`Close ${hint.fact.label} hint`} style={hintStyles.close}>
              <Ionicons name="close" size={18} color="#3A3A3C" />
            </Pressable>
          </View>
          <ScrollView style={{ maxHeight: Math.max(1, position.maxHeight - 64) }} contentContainerStyle={hintStyles.body}>
            {hint.fact.payOptions.map(option => <Text key={option} style={hintStyles.detail}>{option}</Text>)}
            {hint.fact.details.map(detail => <Text key={detail} style={hintStyles.detail}>{detail}</Text>)}
            {hint.fact.morePayOptions ? <Text style={hintStyles.detail}>More pay options on the employer’s site.</Text> : null}
          </ScrollView>
        </View> : null}
      </View>
    </Modal>
  </View>;
}

const hintStyles = StyleSheet.create({
  facts: { marginTop: 8 },
  flow: { flexDirection: 'row', flexWrap: 'wrap', columnGap: 18 },
  item: { maxWidth: '100%' },
  trigger: { flexDirection: 'row', alignItems: 'center', alignSelf: 'flex-start', gap: 5, minHeight: 44, paddingVertical: 6, maxWidth: '100%' },
  pay: { width: '100%' },
  value: { color: '#3A3A3C', fontSize: 14, lineHeight: 21, flexShrink: 1 },
  label: { fontWeight: '600' },
  payText: { color: '#067647', fontWeight: '700' },
  bubble: { position: 'absolute', backgroundColor: '#FFFFFF', borderRadius: 12, padding: 14,
    shadowColor: '#061A33', shadowOffset: { width: 0, height: 6 }, shadowOpacity: 0.16, shadowRadius: 16, elevation: 8 },
  tail: { position: 'absolute', width: 12, height: 12, backgroundColor: '#FFFFFF', transform: [{ rotate: '45deg' }] },
  heading: { flexDirection: 'row', alignItems: 'center', gap: 7, marginBottom: 8 },
  title: { flex: 1, fontSize: 16, fontWeight: '700', lineHeight: 22 },
  close: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center', marginVertical: -10, marginRight: -10 },
  body: { gap: 7 },
  detail: { color: '#3A3A3C', fontSize: 14, lineHeight: 21 },
});
