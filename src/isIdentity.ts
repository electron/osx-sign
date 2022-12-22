import { Identity } from './types';

export const isIdentity = (element: string | Identity): element is Identity => {
  return (
    typeof (element as Identity).name !== 'undefined' &&
    typeof (element as Identity).hash !== 'undefined'
  );
};
