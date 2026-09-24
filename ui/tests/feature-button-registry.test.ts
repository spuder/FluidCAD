// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { FeatureButton } from '../src/interactive/create-feature/feature-button';

function group(): HTMLElement {
  const host = document.createElement('div');
  document.body.appendChild(host);
  return host;
}

function build(host: HTMLElement, label: string, hidden = false): FeatureButton {
  return new FeatureButton(host, {
    icon: `/icons/${label.toLowerCase()}.png`,
    label,
    tip: label,
    ariaLabel: label,
    hidden,
  });
}

const labels = () => FeatureButton.reachable().map((b) => b.labelText);

beforeEach(() => {
  FeatureButton.clearRegistry();
  document.body.innerHTML = '';
});

afterEach(() => {
  FeatureButton.clearRegistry();
  document.body.innerHTML = '';
});

describe('FeatureButton registry', () => {
  it('lists the buttons a user could press, in construction order', () => {
    const host = group();
    build(host, 'Extrude');
    build(host, 'Revolve');

    expect(labels()).toEqual(['Extrude', 'Revolve']);
  });

  it('leaves out hidden and disabled buttons', () => {
    const host = group();
    build(host, 'Extrude');
    build(host, 'Shell', true);
    const chamfer = build(host, 'Chamfer');
    chamfer.setDisabled(true);

    expect(labels()).toEqual(['Extrude']);
  });

  it('comes back once a button is shown and enabled again', () => {
    const host = group();
    const shell = build(host, 'Shell', true);
    expect(labels()).toEqual([]);

    shell.setVisible(true);
    expect(labels()).toEqual(['Shell']);
  });

  // The navbar hides a whole group — the other workbench's tools, or the bar
  // the sketch toolbar takes over — by putting `hidden` on the group host.
  it('leaves out buttons whose navbar group is hidden', () => {
    const host = group();
    build(host, 'Insert');
    expect(labels()).toEqual(['Insert']);

    host.classList.add('hidden');
    expect(labels()).toEqual([]);
  });

  // While a sketch is being edited the create group steps aside for Finish
  // Sketch, so the palette stops offering it until the sketch closes.
  it('leaves out create buttons hidden during a sketch', () => {
    const host = group();
    const extrude = build(host, 'Extrude');
    extrude.setSketchHidden(true);
    expect(labels()).toEqual([]);

    extrude.setSketchHidden(false);
    expect(labels()).toEqual(['Extrude']);
  });

  it('exposes the icon and a click that fires the service handler', () => {
    const host = group();
    const extrude = build(host, 'Extrude');
    const fired: string[] = [];
    extrude.onClick = () => fired.push('extrude');

    expect(extrude.iconSrc).toBe('/icons/extrude.png');
    extrude.click();
    expect(fired).toEqual(['extrude']);
  });
});
