import React from 'react';
import { View, Text, Pressable, ScrollView, StyleSheet, TextInput } from 'react-native';
import { Ionicons } from '@expo/vector-icons';
const { textOnColor } = require('./calendar-ui');

export const theme = {
  ink: '#182421', muted: '#5e6e68', line: '#dce4e0', paper: '#ffffff',
  canvas: '#f5f7f6', accent: '#176b58', soft: '#e7f2ec', warning: '#974219',
};

export function Field(props) {
  return <TextInput placeholderTextColor={theme.muted} selectionColor={theme.accent} {...props} />;
}

export function IconButton({ icon, label, onPress, active, disabled }) {
  return (
    <Pressable
      accessibilityRole="button" accessibilityLabel={label} accessibilityState={{ disabled: Boolean(disabled) }}
      disabled={disabled} onPress={onPress}
      style={({ pressed }) => [s.icon, active && s.iconActive, pressed && s.pressed, disabled && { opacity: 0.4 }]}
    >
      <Ionicons name={icon} size={21} color={active ? '#fff' : theme.ink} />
    </Pressable>
  );
}

export function PersonBadge({ name, color, small = false }) {
  const initials = (name || '?').trim().split(/\s+/).slice(0, 2).map((word) => word[0]).join('').toUpperCase();
  return (
    <View accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[s.person, small && s.personSmall, { backgroundColor: color }]}>
      <Text style={[s.initials, small && { fontSize: 12 }, { color: textOnColor(color) }]}>{initials}</Text>
    </View>
  );
}

export function ChildSelector({ children, value, onChange, colors, includeAll = false }) {
  if (!children.length) return null;
  const options = includeAll ? [null, ...children] : children;
  return (
    <ScrollView horizontal showsHorizontalScrollIndicator={false} style={s.filters} contentContainerStyle={s.filterContent}>
      {options.map((name) => {
        const selected = name === value;
        return (
          <Pressable key={name || '__all'} onPress={() => onChange(name)} accessibilityRole="button"
            accessibilityLabel={name || 'All children'} accessibilityState={{ selected }}
            style={({ pressed }) => [s.filter, selected && s.filterSelected, pressed && s.pressed]}>
            {name ? <View style={[s.dot, { backgroundColor: colors(name) }]} /> : <Ionicons name="people-outline" size={16} color={theme.ink} />}
            <Text style={[s.filterText, selected && { fontWeight: '700' }]}>{name || 'All children'}</Text>
            {selected && <Ionicons name="checkmark" size={15} color={theme.accent} />}
          </Pressable>
        );
      })}
    </ScrollView>
  );
}

export function DetailLine({ icon, text, color = theme.muted }) {
  return <View accessible accessibilityLabel={text} style={s.detail}><Ionicons name={icon} size={17} color={color} /><Text style={[s.detailText, { color }]}>{text}</Text></View>;
}

export function SectionHeading({ title, subtitle, children }) {
  return <View style={s.heading}><View style={{ flex: 1, minWidth: 0 }}><Text style={s.title}>{title}</Text>{subtitle ? <Text style={s.subtitle}>{subtitle}</Text> : null}</View>{children}</View>;
}

const s = StyleSheet.create({
  icon: { width: 44, height: 44, borderRadius: 8, justifyContent: 'center', alignItems: 'center', backgroundColor: theme.soft },
  iconActive: { backgroundColor: theme.accent },
  pressed: { opacity: 0.65 },
  person: { width: 44, height: 44, borderRadius: 8, alignItems: 'center', justifyContent: 'center' },
  personSmall: { width: 30, height: 30, borderRadius: 6 },
  initials: { fontSize: 16, fontWeight: '700' },
  filters: { flexGrow: 0, marginBottom: 16 },
  filterContent: { gap: 8, paddingVertical: 2 },
  filter: { minHeight: 44, flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 12, borderBottomWidth: 2, borderBottomColor: 'transparent' },
  filterSelected: { borderBottomColor: theme.accent, backgroundColor: theme.soft, borderTopLeftRadius: 6, borderTopRightRadius: 6 },
  filterText: { fontSize: 14, color: theme.ink },
  dot: { width: 10, height: 10, borderRadius: 3 },
  detail: { flexDirection: 'row', gap: 9, alignItems: 'flex-start', marginTop: 8 },
  detailText: { flex: 1, fontSize: 14, lineHeight: 21 },
  heading: { flexDirection: 'row', gap: 12, alignItems: 'center', marginBottom: 16 },
  title: { color: theme.ink, fontSize: 19, fontWeight: '700' },
  subtitle: { fontSize: 13, lineHeight: 19, color: theme.muted, marginTop: 3 },
});
