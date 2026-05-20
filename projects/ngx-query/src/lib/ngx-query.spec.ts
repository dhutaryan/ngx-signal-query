import { ComponentFixture, TestBed } from '@angular/core/testing';

import { NgxQuery } from './ngx-query';

describe('NgxQuery', () => {
  let component: NgxQuery;
  let fixture: ComponentFixture<NgxQuery>;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [NgxQuery]
    })
    .compileComponents();

    fixture = TestBed.createComponent(NgxQuery);
    component = fixture.componentInstance;
    fixture.detectChanges();
  });

  it('should create', () => {
    expect(component).toBeTruthy();
  });
});
