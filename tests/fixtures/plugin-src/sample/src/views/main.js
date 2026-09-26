import { connect } from '@oxytocin/plugin-sdk';

void connect().then((view) => {
  document.getElementById('root').textContent = `sample view ${view.viewId}`;
});
